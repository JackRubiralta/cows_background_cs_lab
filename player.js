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

// ximagesink first: it never waits on the compositor. A GL sink on a monitor
// covered by a fullscreen window blocks, which stalled the other monitor down
// to about a frame a second. With CPU scaling at 720p it is also far cheaper
// where OpenGL runs in software (24% CPU against 135%).
// COWS_SINK=glimagesink overrides.
const SINKS = ['ximagesink', 'glimagesink', 'xvimagesink'];

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

const wanted = imports.gi.GLib.getenv('COWS_SINK');
const sinkName = [wanted, ...SINKS].find(n => n && Gst.ElementFactory.find(n));
if (!sinkName)
    die('no usable GStreamer video sink (glimagesink, xvimagesink or ximagesink)');
const canCrop = Gst.ElementFactory.find('aspectratiocrop') !== null;
const VIDEO_ASPECT = 16 / 9;

// playbin finds and links the decoder itself (gjs can't run callbacks on
// GStreamer's streaming threads, which manual decodebin linking needs).
// Its video output goes into our bin: a tee with one branch per monitor.
const pipeline = make('playbin');
pipeline.uri = imports.gi.Gio.File.new_for_path(video).get_uri();
// Video only: playbin's default soft colour-balance and deinterlace filters
// touch every frame and roughly quadrupled the CPU cost.
Gst.util_set_object_arg(pipeline, 'flags', 'video');
const output = new Gst.Bin({name: 'output'});
const tee = make('tee');
output.add(tee);
output.add_pad(Gst.GhostPad.new('sink', tee.get_static_pad('sink')));

const windows = [];
const display = Gdk.Display.get_default();
for (let i = 0; i < display.get_n_monitors(); i++) {
    const geo = display.get_monitor(i).get_geometry();
    const window = makeWindow(geo);
    // Not leaky: a leaky queue never pushes back, so the decoder ran flat out
    // (100% CPU) only for the extra frames to be thrown away. ximagesink never
    // blocks, so one monitor can't stall the others.
    const chain = [make('queue')];
    // Crop only when the monitor's shape differs from the video's (16:9);
    // cropping copies every frame, which slow lab PCs can't afford.
    const crop = canCrop && Math.abs(geo.width / geo.height - VIDEO_ASPECT) > 0.02;
    if (crop) {
        const cropper = make('aspectratiocrop');
        Gst.util_set_object_arg(cropper, 'aspect-ratio', `${geo.width}/${geo.height}`);
        chain.push(make('videoconvert'), rawCaps(), cropper, rawCaps());
    }
    // ximagesink can't scale, so scale to the monitor's real pixel size here.
    const scale = window.get_scale_factor();
    const size = make('capsfilter');
    size.caps = Gst.Caps.from_string(
        `video/x-raw,width=${geo.width * scale},height=${geo.height * scale},pixel-aspect-ratio=1/1`);
    // Convert to X11's RGB format at 720p, then scale: no converter after the
    // scaler, so videoscale (which can't change format) forces that order.
    // Converting at full screen size instead doubled the CPU cost.
    chain.push(make('videoconvert'), make('videoscale'), size);
    const sink = make(sinkName);
    if ('force_aspect_ratio' in sink)
        sink.force_aspect_ratio = false;
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
    case Gst.MessageType.QOS: {
        const [, processed, dropped] = msg.parse_qos_stats();
        qos.set(msg.src.get_name(), [processed, dropped]);
        break;
    }
    case Gst.MessageType.ERROR: {
        const [err, dbg] = msg.parse_error();
        printerr(`player: ${err.message}\n${dbg}`);
        Gtk.main_quit();
        break;
    }
    }
});

// COWS_DEBUG=1: print frames processed/dropped every 5 s (from the QoS
// reports sinks send whenever they have to drop a late frame).
const qos = new Map();
if (imports.gi.GLib.getenv('COWS_DEBUG')) {
    imports.gi.GLib.timeout_add_seconds(0, 5, () => {
        print(`${sinkName}: ` + (qos.size ? [...qos.entries()].map(([n, [p, d]]) =>
            `${n} processed ${p} dropped ${d}`).join(' | ') : 'no frames dropped'));
        return true;
    });
}

pipeline.set_state(Gst.State.PAUSED);
Gtk.main();
pipeline.set_state(Gst.State.NULL);
