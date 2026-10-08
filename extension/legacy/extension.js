// cows-background, GNOME 40 to 44 (same as ../esm/extension.js, old module style).
//
// player.py opens one window per monitor titled "cows-background". This
// extension paints a live clone of each one into GNOME's background layer,
// just above the wallpaper, and makes the window itself invisible. The video
// then really is the desktop background. Disabling restores the windows.

const {Clutter, GLib} = imports.gi;
const Main = imports.ui.main;

const TITLE = 'cows-background';

class CowsBackground {
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
            if (this._clones && this._clones.has(actor))
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

function init() {
    return new CowsBackground();
}
