#!/bin/bash
# cows & cows & cows as your GNOME desktop background, no sudo needed.
#
#   ./cows.sh                 turn it on (ping-pong: whole video forward, then backward)
#   ./cows.sh perfect         turn it on (the 19.5 s section that loops invisibly)
#   ./cows.sh off             put your normal background back
#   ./cows.sh off --purge     ...and delete everything it downloaded or installed
#   ./cows.sh status
#   --method auto|extension|window   how to show it (default: auto)
#
# Two methods, picked automatically:
#   extension  The video is GNOME's real background layer, via a small
#              extension installed in your home folder. GNOME loads a newly
#              installed extension only at login, so the first time you need
#              to log out and back in once; after that it is instant.
#   window     The video plays in a window GNOME keeps below everything else.
#              Works straight away; used until the extension is active, or if
#              this machine blocks extensions.
#
# The first run downloads the video (plus ffmpeg and yt-dlp if missing) into
# your own folders and prepares the loop, which takes a few minutes. GNOME's
# own background setting is never changed.

set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/cows-background-lab"
TOOLS="${TMPDIR:-/tmp}/cows-background-tools-$(id -u)"
PIDFILE="$CACHE/player.pid"
LOG="$CACHE/player.log"

URL="https://www.youtube.com/watch?v=FavUpD_IjVY"
FORMAT="248-sr/bestvideo[height<=1080][fps<=30]"
FPS=25
# Frame ranges [first, end) at 25 fps. The title is gone by frame 164 and the
# fade to black + credit starts at 3176. Frame 2250 looks the same as 1762.
PINGPONG=166:3173
PERFECT=1762:2250

say() { echo "cows: $*" >&2; }
die() { echo "cows: $*" >&2; exit 1; }

# ---------------------------------------------------------------- tools

FFMPEG="" FFPROBE="" YTDLP=""
get_tools() {
  mkdir -p "$TOOLS"
  if [[ -z ${COWS_BUNDLED:-} ]] && command -v ffmpeg >/dev/null && command -v ffprobe >/dev/null; then
    FFMPEG=ffmpeg FFPROBE=ffprobe
  else
    if [[ ! -x $TOOLS/ffmpeg ]]; then
      say "downloading ffmpeg (static build, into $TOOLS)"
      curl -fL --progress-bar https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz |
        tar -xJ -C "$TOOLS" --strip-components=1 --wildcards '*/ffmpeg' '*/ffprobe'
    fi
    FFMPEG=$TOOLS/ffmpeg FFPROBE=$TOOLS/ffprobe
  fi
  if [[ -z ${COWS_BUNDLED:-} ]] && command -v yt-dlp >/dev/null; then
    YTDLP=yt-dlp
  else
    if [[ ! -x $TOOLS/yt-dlp ]]; then
      say "downloading yt-dlp (into $TOOLS)"
      curl -fL --progress-bar -o "$TOOLS/yt-dlp" \
        https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux
      chmod +x "$TOOLS/yt-dlp"
    fi
    YTDLP=$TOOLS/yt-dlp
  fi
}

# YouTube sometimes cuts a download off (HTTP 403) unless yt-dlp can solve its
# JavaScript challenge, which needs deno. Resume first; fetch deno if needed.
download_source() {
  local try
  for try in 1 2 3; do
    "$YTDLP" --no-playlist --retries 10 --fragment-retries 10 -f "$FORMAT" \
      -o "$CACHE/src.%(ext)s" "$URL" >&2 && return 0
    say "download interrupted, retrying ($try/3)"
  done
  return 1
}

get_deno() {
  command -v deno >/dev/null && return 0
  if [[ ! -x $TOOLS/deno ]]; then
    say "fetching deno so yt-dlp can answer YouTube's check (into $TOOLS)"
    curl -fL --progress-bar -o "$TOOLS/deno.zip" \
      https://github.com/denoland/deno/releases/latest/download/deno-x86_64-unknown-linux-gnu.zip || return 1
    if command -v unzip >/dev/null; then
      unzip -oq "$TOOLS/deno.zip" -d "$TOOLS"
    else
      python3 -m zipfile -e "$TOOLS/deno.zip" "$TOOLS"
    fi
    chmod +x "$TOOLS/deno"
    rm -f "$TOOLS/deno.zip"
  fi
  export PATH="$TOOLS:$PATH"
}

# ---------------------------------------------------------------- video

seek_to() { (($1 > 0)) && awk -v f="$1" -v r="$FPS" 'BEGIN { printf "-ss %.6f", (f - 0.5) / r }'; return 0; }
count_frames() { "$FFPROBE" -v error -select_streams v:0 -count_packets -show_entries stream=nb_read_packets -of csv=p=0 "$1"; }

# 720p VP8 in WebM: GNOME's own GStreamer plays it with no extra codecs, and
# it decodes several times faster than 1080p VP9 (which made lab PCs drop to
# about one frame a second). The original is 480p, so nothing is lost.
SCALE="scale=1280:720:flags=lanczos"
ENCODE=(-an -c:v libvpx -b:v 3M -crf 6 -qmin 2 -qmax 30 -deadline good -cpu-used 4
  -auto-alt-ref 0 -g 250 -pix_fmt yuv420p)
VERSION=v2  # bump when the encoding changes, so old renders are rebuilt

build() {
  local mode=$1 out="$CACHE/cows-$1.$VERSION.webm"
  [[ -s $out ]] && return
  rm -f "$CACHE/cows-$mode.webm" "$CACHE"/cows-"$mode".v*.webm
  get_tools
  mkdir -p "$CACHE"
  local src
  src=$(compgen -G "$CACHE/src.*" | grep -v '\.part$' | head -n1 || true)
  if [[ -z $src ]]; then
    say "downloading cows & cows & cows"
    download_source || { get_deno && download_source; } || die "YouTube refused the download; try again in a minute"
    src=$(compgen -G "$CACHE/src.*" | grep -v '\.part$' | head -n1)
  fi

  local range first end tmp
  range=${mode^^}; range=${!range}
  first=${range%:*} end=${range#*:}
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/cows-build.XXXXXX")
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" EXIT

  if [[ $mode == perfect ]]; then
    say "preparing the perfect loop"
    # shellcheck disable=SC2046
    "$FFMPEG" -v error -stats -y $(seek_to "$first") -i "$src" -frames:v $((end - first)) \
      -vf "$SCALE,setpts=N/($FPS*TB)" -r $FPS "${ENCODE[@]}" "$tmp/out.webm"
  else
    say "preparing the ping-pong loop: forward"
    # shellcheck disable=SC2046
    "$FFMPEG" -v error -stats -y $(seek_to "$first") -i "$src" -frames:v $((end - first)) \
      -an -c:v libx264 -preset veryfast -crf 12 "$tmp/0000.mkv"
    local frames hi lo k=1
    frames=$(count_frames "$tmp/0000.mkv")
    end=$((first + frames))
    say "backward"
    hi=$((end - 1))
    while ((hi > first + 1)); do
      lo=$((hi - 50 > first + 1 ? hi - 50 : first + 1))
      # trim, not just -frames:v: reverse waits for the end of its input.
      # shellcheck disable=SC2046
      "$FFMPEG" -v error -y $(seek_to "$lo") -i "$src" -frames:v $((hi - lo)) \
        -vf "trim=end_frame=$((hi - lo)),reverse" -an -c:v libx264 -preset veryfast -crf 12 \
        "$tmp/$(printf %04d "$k").mkv"
      printf '\r  %d%%' $((100 * (end - lo) / (end - first))) >&2
      hi=$lo k=$((k + 1))
    done
    echo >&2
    for f in "$tmp"/*.mkv; do printf "file '%s'\n" "$f"; done >"$tmp/list.txt"
    say "encoding"
    "$FFMPEG" -v error -stats -y -f concat -safe 0 -i "$tmp/list.txt" \
      -vf "$SCALE,setpts=N/($FPS*TB)" -r $FPS "${ENCODE[@]}" "$tmp/out.webm"
    local got
    got=$(count_frames "$tmp/out.webm")
    ((got == 2 * frames - 2)) || die "ping-pong came out with $got frames instead of $((2 * frames - 2))"
  fi
  mv "$tmp/out.webm" "$out"
  rm -rf "$tmp"
  trap - EXIT
}

# ---------------------------------------------------------------- extension

EXT_UUID=cows-background@jackrubiralta.github.io
EXT_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$EXT_UUID"
EXT_FLIPPED="$CACHE/turned-on-user-extensions"

is_gnome() { [[ ${XDG_CURRENT_DESKTOP:-} == *GNOME* ]] && command -v gnome-shell >/dev/null; }
ext_active() { [[ $(gnome-extensions info "$EXT_UUID" 2>/dev/null | sed -n 's/^[[:space:]]*State: //p') =~ ^(ACTIVE|ENABLED)$ ]]; }

# Copies the variant that matches this GNOME (40-44 or 45+) into place.
ext_install() {
  local major
  major=$(gnome-shell --version 2>/dev/null | grep -oE '[0-9]+' | head -n1)
  [[ -n $major ]] && ((major >= 40)) || return 1
  mkdir -p "$EXT_DIR"
  cp "$HERE/extension/$( ((major >= 45)) && echo esm || echo legacy)"/{extension.js,metadata.json} "$EXT_DIR/"
}

# enable|disable through the user's own GNOME settings. enable prints "ok",
# or "blocked" if an administrator locked extensions. If user extensions were
# switched off, enable switches them on and remembers that so disable can
# switch them off again.
gs() { gsettings "$1" org.gnome.shell "${@:2}"; }
strv_remove() {
  local cur new
  cur=$(gs get "$1")
  [[ $cur == *"'$EXT_UUID'"* ]] || return 0
  new=$(sed "s/, '$EXT_UUID'//; s/'$EXT_UUID', //; s/'$EXT_UUID'//" <<<"$cur")
  [[ $new == "[]" ]] && new="@as []"
  [[ $(gs writable "$1") == true ]] && gs set "$1" "$new"
  return 0
}
ext_settings() {
  mkdir -p "$CACHE"
  if [[ $1 == enable ]]; then
    if [[ $(gs get disable-user-extensions) == true && $(gs writable disable-user-extensions) == true ]]; then
      gs set disable-user-extensions false
      : >"$EXT_FLIPPED"
    fi
    strv_remove disabled-extensions
    local cur
    cur=$(gs get enabled-extensions)
    if [[ $cur != *"'$EXT_UUID'"* && $(gs writable enabled-extensions) == true ]]; then
      if [[ $cur == "@as []" || $cur == "[]" ]]; then gs set enabled-extensions "['$EXT_UUID']"
      else gs set enabled-extensions "${cur%]}, '$EXT_UUID']"; fi
    fi
    if [[ $(gs get enabled-extensions) == *"'$EXT_UUID'"* && $(gs get disable-user-extensions) == false ]]; then
      echo ok
    else
      echo blocked
    fi
  else
    strv_remove enabled-extensions
    if [[ -f $EXT_FLIPPED ]]; then
      gs set disable-user-extensions true
      rm -f "$EXT_FLIPPED"
    fi
  fi
}

# ---------------------------------------------------------------- player

running_pid() {
  local pid
  pid=$(cat "$PIDFILE" 2>/dev/null) || return 1
  [[ -n $pid ]] && grep -q 'player.js' "/proc/$pid/cmdline" 2>/dev/null && echo "$pid"
}

stop_player() {
  local pid
  if pid=$(running_pid); then
    kill "$pid" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$pid" 2>/dev/null || break; sleep 0.2; done
    kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$PIDFILE"
}

check_runtime() {
  [[ -n ${DISPLAY:-}${WAYLAND_DISPLAY:-} ]] || die "run this from a terminal inside your desktop session"
  command -v gjs >/dev/null || die "needs gjs, which every GNOME desktop has; is this GNOME?"
  gjs -c "
imports.gi.versions.Gtk = '3.0'; imports.gi.versions.Gdk = '3.0'; imports.gi.versions.GdkX11 = '3.0';
imports.gi.versions.Gst = '1.0'; imports.gi.versions.GstVideo = '1.0';
const {Gst, Gtk, GdkX11, GstVideo} = imports.gi;
Gst.init(null);
const has = n => Gst.ElementFactory.find(n) !== null;
const missing = [];
if (!has('matroskademux')) missing.push('matroskademux');
if (!['vp9dec', 'avdec_vp9', 'vavp9dec', 'vaapivp9dec'].some(has)) missing.push('a VP9 decoder');
if (!['glimagesink', 'xvimagesink', 'ximagesink'].some(has)) missing.push('a video sink');
if (missing.length) { printerr('missing GStreamer pieces: ' + missing.join(', ')); imports.system.exit(1); }
" || die "this machine's GTK 3 / GStreamer can't play the video (see the message above)"
}

cmd_on() {
  local mode=$1 method=$2 ext=unsupported
  check_runtime
  build "$mode"
  stop_player

  if is_gnome; then
    if [[ $method == window ]]; then
      ext_settings disable
      ext=off
    elif ext_install; then
      ext=$(ext_settings enable)
    fi
  fi
  [[ $method == extension && $ext == unsupported ]] && die "the extension method needs GNOME 40 or newer"

  # setsid: keeps playing after the terminal is closed, until you log out.
  # X11 (XWayland on Wayland): window types and video embedding need it.
  env -u WAYLAND_DISPLAY GDK_BACKEND=x11 GST_GL_WINDOW=x11 \
    setsid gjs "$HERE/player.js" "$CACHE/cows-$mode.$VERSION.webm" >"$LOG" 2>&1 </dev/null &
  echo $! >"$PIDFILE"
  echo "$mode" >"$CACHE/mode"
  sleep 2
  running_pid >/dev/null || { cat "$LOG" >&2; rm -f "$PIDFILE"; die "the player stopped straight away (log above)"; }

  if [[ $ext == ok ]] && ext_active; then
    say "on ($mode), as the real desktop background."
  elif [[ $ext == ok ]]; then
    say "on ($mode), in a window behind everything for now."
    say "log out and back in once, then run ./cows.sh again: it becomes the real background."
  elif [[ $ext == blocked ]]; then
    say "on ($mode), in a window behind everything (this machine blocks GNOME extensions)."
  else
    say "on ($mode), in a window behind everything."
  fi
  say "'./cows.sh off' puts your normal background back."
}

cmd_off() {
  stop_player
  is_gnome && ext_settings disable
  rm -f "$CACHE/mode" "$LOG"
  rm -rf "${TMPDIR:-/tmp}"/cows-build.* 2>/dev/null || true
  if ((PURGE)); then
    rm -rf "$CACHE" "$TOOLS" "$EXT_DIR"
    say "off; everything it downloaded or installed is deleted"
  else
    say "off; your normal background is back"
  fi
}

cmd_status() {
  if ! running_pid >/dev/null; then
    echo off
  elif is_gnome && ext_active; then
    echo "on ($(cat "$CACHE/mode" 2>/dev/null)), real background (extension)"
  else
    echo "on ($(cat "$CACHE/mode" 2>/dev/null)), window behind everything"
  fi
}

COMMAND=on MODE=pingpong METHOD=auto PURGE=0
while (($#)); do
  case $1 in
    on | off | status) COMMAND=$1 ;;
    pingpong | perfect) MODE=$1 ;;
    --method) METHOD=${2:?--method needs auto, extension or window}; shift ;;
    --method=*) METHOD=${1#*=} ;;
    --purge) PURGE=1 ;;
    -h | --help | help) sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument '$1' (try ./cows.sh help)" ;;
  esac
  shift
done
[[ $METHOD =~ ^(auto|extension|window)$ ]] || die "unknown method '$METHOD' (auto, extension or window)"

case $COMMAND in
  on) cmd_on "$MODE" "$METHOD" ;;
  off) cmd_off ;;
  status) cmd_status ;;
esac
