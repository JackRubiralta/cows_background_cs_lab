// Play a video as the GNOME desktop background, without sudo.
//
// Runs on gjs, the JavaScript runtime GNOME Shell itself is built on, so it
// works on any GNOME machine with nothing extra installed.
//
// Each monitor gets a borderless window of type DESKTOP. GNOME keeps desktop
// windows below every other window and out of the taskbar, overview and
// Alt+Tab, in X11 sessions and (through XWayland) in Wayland sessions alike.
// One decoder feeds every monitor, and the video loops with segment seeks, so
// the jump back to the start is frame-exact with no pause.
//
// When the cows-background GNOME Shell extension is active it goes one step
// further: it hides these windows and paints them into GNOME's real
// background layer instead (see extension/).
//
// Usage: gjs player.js VIDEO
// cows.sh starts it with GDK_BACKEND=x11, GST_GL_WINDOW=x11 and no
// WAYLAND_DISPLAY: window types and video embedding need X11, and the GL video
// sink crashes if it talks to Wayland while drawing into an X11 window.

imports.gi.versions.Gtk = '3.0';
imports.gi.versions.Gdk = '3.0';
imports.gi.versions.GdkX11 = '3.0';
imports.gi.versions.Gst = '1.0';
imports.gi.versions.GstVideo = '1.0';
const {Gdk, GdkX11, Gst, GstVideo, Gtk} = imports.gi;
void GdkX11; void GstVideo; // loaded for get_xid() and set_window_handle()

const SINKS = ['glimagesink', 'xvimagesink', 'ximagesink'];

function die(msg) {
    printerr(`player: ${msg}`);
    imports.system.exit(1);
}

function make(name) {
    const e = Gst.ElementFactory.make(name, null);
    if (!e)
        die(`GStreamer element ${name} is missing`);
    return e;
}

// Cropping needs plain frames in system memory on both sides.
function rawCaps() {
    const f = make('capsfilter');
    f.caps = Gst.Caps.from_string('video/x-raw(memory:SystemMemory)');
    return f;
}

function makeWindow(geo) {
    const w = new Gtk.Window({type: Gtk.WindowType.TOPLEVEL, title: 'cows-background'});
    w.set_type_hint(Gdk.WindowTypeHint.DESKTOP);
    w.set_decorated(false);
    w.set_skip_taskbar_hint(true);
    w.set_skip_pager_hint(true);
    w.set_keep_below(true);
    w.set_accept_focus(false);
    w.set_focus_on_map(false);
    w.stick();
    w.move(geo.x, geo.y);
    w.set_default_size(geo.width, geo.height);
    w.set_size_request(geo.width, geo.height);
    w.add(new Gtk.DrawingArea());
    w.connect('delete-event', () => true);
    w.show_all();
    w.move(geo.x, geo.y);
    return w;
}

const video = ARGV[0];
if (!video || !imports.gi.Gio.File.new_for_path(video).query_exists(null))
    die('usage: gjs player.js VIDEO');

Gtk.init(null);
Gst.init(null);

const sinkName = SINKS.find(n => Gst.ElementFactory.find(n));
if (!sinkName)
    die('no usable GStreamer video sink (glimagesink, xvimagesink or ximagesink)');
const canCrop = Gst.ElementFactory.find('aspectratiocrop') !== null;

// playbin finds and links the decoder itself (gjs can't run callbacks on
// GStreamer's streaming threads, which manual decodebin linking needs).
// Its video output goes into our bin: convert -> tee -> one branch per monitor.
const pipeline = make('playbin');
pipeline.uri = imports.gi.Gio.File.new_for_path(video).get_uri();
const output = new Gst.Bin({name: 'output'});
const convert = make('videoconvert');
const toRaw = rawCaps();
const tee = make('tee');
for (const e of [convert, toRaw, tee])
    output.add(e);
convert.link(toRaw);
toRaw.link(tee);
output.add_pad(Gst.GhostPad.new('sink', convert.get_static_pad('sink')));

const windows = [];
const display = Gdk.Display.get_default();
for (let i = 0; i < display.get_n_monitors(); i++) {
    const geo = display.get_monitor(i).get_geometry();
    const window = makeWindow(geo);
    const chain = [make('queue')];
    if (canCrop) {
        const crop = make('aspectratiocrop');
        Gst.util_set_object_arg(crop, 'aspect-ratio', `${geo.width}/${geo.height}`);
        chain.push(rawCaps(), crop, rawCaps(), make('videoconvert'));
    }
    const sink = make(sinkName);
    sink.force_aspect_ratio = !canCrop;
    sink.sync = true;
    chain.push(sink);
    for (const e of chain)
        output.add(e);
    tee.link(chain[0]);
    for (let j = 1; j < chain.length; j++)
        chain[j - 1].link(chain[j]);
    sink.set_window_handle(window.get_window().get_xid());
    windows.push(window);
}

pipeline.video_sink = output;

let started = false;
const bus = pipeline.get_bus();
bus.add_signal_watch();
bus.connect('message', (_bus, msg) => {
    switch (msg.type) {
    case Gst.MessageType.ASYNC_DONE:
        if (!started) {
            // First segment seek; every SEGMENT_DONE after it loops seamlessly.
            started = true;
            pipeline.seek_simple(Gst.Format.TIME, Gst.SeekFlags.FLUSH | Gst.SeekFlags.SEGMENT, 0);
            pipeline.set_state(Gst.State.PLAYING);
        }
        break;
    case Gst.MessageType.SEGMENT_DONE:
        pipeline.seek_simple(Gst.Format.TIME, Gst.SeekFlags.SEGMENT, 0);
        break;
    case Gst.MessageType.EOS:
        pipeline.seek_simple(Gst.Format.TIME, Gst.SeekFlags.FLUSH, 0);
        break;
    case Gst.MessageType.ERROR: {
        const [err, dbg] = msg.parse_error();
        printerr(`player: ${err.message}\n${dbg}`);
        Gtk.main_quit();
        break;
    }
    }
});

pipeline.set_state(Gst.State.PAUSED);
Gtk.main();
pipeline.set_state(Gst.State.NULL);
