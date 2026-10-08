#!/usr/bin/env python3
"""Play a video as the GNOME desktop background, without sudo.

Each monitor gets a borderless window of type DESKTOP. GNOME keeps desktop
windows below every other window and out of the taskbar, overview and
Alt+Tab, in X11 sessions and (through XWayland) in Wayland sessions alike.
One decoder feeds every monitor, and the video loops with segment seeks, so
the jump back to the start is frame-exact with no pause.

When the cows-background GNOME Shell extension is active it goes one step
further: it hides these windows and paints them into GNOME's real background
layer instead (see extension/).

Usage: player.py VIDEO
"""

import os
import signal
import sys
import warnings

warnings.filterwarnings("ignore", category=DeprecationWarning)

# X11 (XWayland on Wayland sessions): window types and embedding need it.
# GStreamer's GL sink must use X11 too, or it talks to Wayland and crashes.
os.environ["GDK_BACKEND"] = "x11"
os.environ["GST_GL_WINDOW"] = "x11"
os.environ.pop("WAYLAND_DISPLAY", None)

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
gi.require_version("GdkX11", "3.0")
gi.require_version("Gst", "1.0")
gi.require_version("GstVideo", "1.0")
from gi.repository import Gdk, GdkX11, GLib, Gst, GstVideo, Gtk  # noqa: E402,F401

SINKS = ("glimagesink", "xvimagesink", "ximagesink")


def pick_sink():
    for name in SINKS:
        if Gst.ElementFactory.find(name):
            return name
    sys.exit("player: no usable GStreamer video sink (glimagesink/xvimagesink/ximagesink)")


def raw_caps():
    f = Gst.ElementFactory.make("capsfilter")
    f.set_property("caps", Gst.Caps.from_string("video/x-raw(memory:SystemMemory)"))
    return f


class Player:
    def __init__(self, video):
        self.video = video
        self.windows = []
        self.pipeline = Gst.Pipeline.new("cows")
        sink_name = pick_sink()
        crop_ok = Gst.ElementFactory.find("aspectratiocrop") is not None

        src = Gst.ElementFactory.make("filesrc")
        src.set_property("location", video)
        decode = Gst.ElementFactory.make("decodebin")
        convert = Gst.ElementFactory.make("videoconvert")
        to_raw = raw_caps()
        tee = Gst.ElementFactory.make("tee")
        for e in (src, decode, convert, to_raw, tee):
            self.pipeline.add(e)
        src.link(decode)
        convert.link(to_raw)
        to_raw.link(tee)
        decode.connect("pad-added", lambda _d, pad: pad.link(convert.get_static_pad("sink"))
                       if pad.query_caps(None).to_string().startswith("video/") else None)

        display = Gdk.Display.get_default()
        for i in range(display.get_n_monitors()):
            geo = display.get_monitor(i).get_geometry()
            window = self.make_window(geo)
            chain = [Gst.ElementFactory.make("queue")]
            if crop_ok:
                # Cropping needs plain frames in system memory on both sides.
                crop = Gst.ElementFactory.make("aspectratiocrop")
                Gst.util_set_object_arg(crop, "aspect-ratio", f"{geo.width}/{geo.height}")
                chain += [raw_caps(), crop, raw_caps(), Gst.ElementFactory.make("videoconvert")]
            sink = Gst.ElementFactory.make(sink_name)
            sink.set_property("force-aspect-ratio", not crop_ok)
            sink.set_property("sync", True)
            chain.append(sink)
            for e in chain:
                self.pipeline.add(e)
            tee.link(chain[0])
            for a, b in zip(chain, chain[1:]):
                a.link(b)
            sink.set_window_handle(window.get_window().get_xid())
            self.windows.append(window)

        bus = self.pipeline.get_bus()
        bus.add_signal_watch()
        bus.connect("message", self.on_message)
        self.started = False
        self.pipeline.set_state(Gst.State.PAUSED)

    def make_window(self, geo):
        w = Gtk.Window(type=Gtk.WindowType.TOPLEVEL)
        w.set_title("cows-background")
        w.set_type_hint(Gdk.WindowTypeHint.DESKTOP)
        w.set_decorated(False)
        w.set_skip_taskbar_hint(True)
        w.set_skip_pager_hint(True)
        w.set_keep_below(True)
        w.set_accept_focus(False)
        w.set_focus_on_map(False)
        w.stick()
        w.move(geo.x, geo.y)
        w.set_default_size(geo.width, geo.height)
        w.set_size_request(geo.width, geo.height)
        area = Gtk.DrawingArea()
        w.add(area)
        w.connect("delete-event", lambda *_: True)
        w.show_all()
        w.move(geo.x, geo.y)
        return w

    def on_message(self, _bus, msg):
        t = msg.type
        if t == Gst.MessageType.ASYNC_DONE and not self.started:
            # First segment seek; every SEGMENT_DONE after it loops seamlessly.
            self.started = True
            self.pipeline.seek_simple(Gst.Format.TIME,
                                      Gst.SeekFlags.FLUSH | Gst.SeekFlags.SEGMENT, 0)
            self.pipeline.set_state(Gst.State.PLAYING)
        elif t == Gst.MessageType.SEGMENT_DONE:
            self.pipeline.seek_simple(Gst.Format.TIME, Gst.SeekFlags.SEGMENT, 0)
        elif t == Gst.MessageType.EOS:
            self.pipeline.seek_simple(Gst.Format.TIME, Gst.SeekFlags.FLUSH, 0)
        elif t == Gst.MessageType.ERROR:
            err, dbg = msg.parse_error()
            print(f"player: {err.message}\n{dbg}", file=sys.stderr)
            Gtk.main_quit()

    def stop(self, *_):
        self.pipeline.set_state(Gst.State.NULL)
        Gtk.main_quit()
        return False


def main():
    if len(sys.argv) != 2 or not os.path.isfile(sys.argv[1]):
        sys.exit("usage: player.py VIDEO")
    Gst.init(None)
    player = Player(os.path.abspath(sys.argv[1]))
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, sig, player.stop)
    Gtk.main()


if __name__ == "__main__":
    main()
