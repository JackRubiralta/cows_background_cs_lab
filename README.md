# cows_background_cs_lab

cyriak's [**cows & cows & cows**](https://www.youtube.com/watch?v=FavUpD_IjVY)
as your desktop background on a GNOME lab machine (AlmaLinux 9 or 10),
looping forever with no title and no credits. **No sudo needed.**

```bash
git clone https://github.com/JackRubiralta/cows_background_cs_lab
cd cows_background_cs_lab
./cows.sh            # on: the whole video forward, then backward (ping-pong)
./cows.sh perfect    # on: the 19.5 s section that loops invisibly
./cows.sh off        # back to your normal background
```

The first run takes a few minutes. It downloads the video, plus `ffmpeg` and
`yt-dlp` if the machine doesn't have them, into your own folders, and
prepares the loop. After that `./cows.sh` starts instantly.

## How it shows the video

`./cows.sh` chooses the best method that works on the machine:

| Method | What you get | When |
|---|---|---|
| **extension** | The video *is* GNOME's background layer, exactly where the wallpaper is. | A small GNOME Shell extension, installed in `~/.local/share/gnome-shell/extensions`. GNOME only loads a newly installed extension at login, so the **first time, log out and back in once and run `./cows.sh` again**. After that it is the real background straight away. |
| **window** | The video plays in a borderless window that GNOME keeps behind every other window, out of the taskbar and Alt+Tab. It looks the same on the desktop. | Straight away, the very first time, and on machines where an administrator has blocked extensions. |

Force one with `--method extension` or `--method window`. `./cows.sh status`
says which one is in use.

It works in both GNOME on Wayland (the default) and GNOME on Xorg. Nothing
needs installing: the player runs on `gjs`, the JavaScript runtime GNOME
Shell itself is built on, and decodes the video with the GStreamer GNOME
already uses.

## Turning it off

`./cows.sh off` stops the video and disables the extension. If the script
had to switch on user extensions for you, it switches them off again. GNOME's
own background setting is never touched. `./cows.sh off --purge` also deletes
the prepared videos (`~/.cache/cows-background-lab`), the downloaded tools
and the extension.

The video keeps playing after you close the terminal, until you log out.
Run `./cows.sh` again after logging in.

## The two loops

The end of the video doesn't match its start. Every frame was compared with
every other frame, so a loop of the whole video always has a visible jump.
That's why there are two modes:

- **pingpong** (the default) plays everything between the title and the fade
  to black forward, then backward, so it never jumps.
- **perfect** loops 70.48 s to 89.96 s. There, the last frame flows into the
  first more smoothly than two ordinary frames do.

The Omarchy/Hyprland version is
[cows_background](https://github.com/JackRubiralta/cows_background).

## Credits

*cows & cows & cows* is by [cyriak](https://www.youtube.com/@cyriak) (2010).
This repository does not contain the video. It is downloaded from cyriak's
own upload.
