// cows-background, GNOME 45 and later.
//
// player.py opens one window per monitor titled "cows-background". This
// extension paints a live clone of each one into GNOME's background layer,
// just above the wallpaper, and makes the window itself invisible. The video
// then really is the desktop background. Disabling restores the windows.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const TITLE = 'cows-background';

export default class CowsBackground extends Extension {
    enable() {
        this._clones = new Map();
        this._mapId = global.window_manager.connect('map', (_wm, actor) => this._adopt(actor));
        for (const actor of global.get_window_actors())
            this._adopt(actor);
    }

    _adopt(actor) {
        const win = actor.meta_window;
        if (!win || win.get_title() !== TITLE || this._clones.has(actor))
            return;
        const clone = new Clutter.Clone({source: actor, reactive: false});
        clone.add_constraint(new Clutter.BindConstraint({source: actor, coordinate: Clutter.BindCoordinate.POSITION}));
        clone.add_constraint(new Clutter.BindConstraint({source: actor, coordinate: Clutter.BindCoordinate.SIZE}));
        Main.layoutManager._backgroundGroup.add_child(clone);
        const destroyId = actor.connect('destroy', () => {
            clone.destroy();
            this._clones.delete(actor);
        });
        this._clones.set(actor, {clone, destroyId});
        // After GNOME's own map handling, which may set the opacity.
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (this._clones?.has(actor))
                actor.opacity = 0;
            return GLib.SOURCE_REMOVE;
        });
    }

    disable() {
        global.window_manager.disconnect(this._mapId);
        for (const [actor, {clone, destroyId}] of this._clones) {
            actor.disconnect(destroyId);
            clone.destroy();
            actor.opacity = 255;
        }
        this._clones = null;
    }
}
