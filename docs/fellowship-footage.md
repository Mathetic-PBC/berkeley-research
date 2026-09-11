# Footage credits

The published 1080p montage is in `fellowship/media/`. Source paths below refer to the local editing package at `Desktop/Mathetic, PBC/Fellowship`. Reproduction scripts and the shot manifest are retained in `docs/fellowship-edit/`; run `python3 docs/fellowship-edit/render.py --root "/path/to/Fellowship"` to rebuild the local package.

Retrieved 11 September 2026. Timecodes below refer to the downloaded source files, not other uploads of the same events. All footage is archival; no generated or reenacted footage was added.

| Montage time | Image | Source time |
|---|---|---|
| 00:00–00:02 | Douglas Engelbart, 1968 demonstration | 02:00.0–02:02.0 |
| 00:02–00:03.6 | Engelbart's mouse in use | 31:40.0–31:41.6 |
| 00:03.6–00:05.8 | Barbara Baird demonstrating the Xerox Alto | 03:14.5–03:16.7 |
| 00:05.8–00:07.6 | Drawing on the Alto | 17:00.0–17:01.8 |
| 00:07.6–00:09.4 | Steve Jobs introducing Macintosh | 00:29.0–00:30.8 |
| 00:09.4–00:11.4 | Macintosh demonstration | 01:15.0–01:17.0 |
| 00:11.4–00:13 | Seymour Papert at MIT | 00:11.0–00:12.6 |
| 00:13–00:15 | Children programming with Logo | 00:48.0–00:50.0 |
| 00:15–00:18 | Child watching a physical Logo turtle draw | 01:02.4–01:05.4 |

## Engelbart

- Event: *A Research Center for Augmenting Human Intellect*, 9 December 1968, often called the Mother of All Demos.
- [Doug Engelbart Institute's demo archive](https://www.dougengelbart.org/mousesite/1968Demo.html)
- [Doug Engelbart Institute: remastered reel 1](https://www.youtube.com/watch?v=UhpTiWyVa6k). Stanford Libraries Special Collections remastered the film in 2022.
- Local file: `sources/engelbart-remastered.mp4` (1550 × 1080, YouTube format 137); metadata retained alongside it.
- Replaces the earlier 320 × 240 highlights copy; timecodes above now refer to the remastered reel.

## Xerox PARC

- *Bob Taylor, Barbara Baird: Xerox Alto Demonstration — August 1978.*
- [Archive catalog and recording](https://archive.org/details/Xerox_Palo_Alto_Demo_August_1978)
- [Original AVI](https://archive.org/download/Xerox_Palo_Alto_Demo_August_1978/Xerox_Palo_Alto_Demo_August_1978.avi) (720 × 486).
- Local loss-minimizing ProRes extracts: `sources/alto-original-baird.mov` and `sources/alto-original-drawing.mov`, starting at 03:14.5 and 17:00.0 in the original respectively. The table uses original AVI timecodes; the shot manifest uses 0.0 for these local excerpts.
- Replaces the 712 × 480 compressed MP4 derivative.
- This is a research demonstration, not the 1979 Xerox office commercial or footage of Jobs visiting PARC.

## Macintosh

- Event: Macintosh introduction, Apple shareholders meeting, 24 January 1984.
- [*The Lost 1984 Video: young Steve Jobs introduces the Macintosh*](https://www.youtube.com/watch?v=2B-XwPjn9YY), uploaded by macessentials / TextLab, which describes discovering and restoring the recording.
- Local file: `sources/macintosh-restored.mp4` (960 × 720, supplied by the hosting platform; this does not imply native HD archival detail).
- Download metadata: `sources/macintosh-restored.info.json`.

## Papert and Logo

- [MIT CSAIL: *Channel 5 Special (AI Film #10)*](https://www.csail.mit.edu/node/6662).
- [Downloaded media](https://projects.csail.mit.edu/video/history/aifilms/10-robot.mp4).
- Local file: `sources/papert-channel5.mp4` (320 × 240).
- The catalog describes Papert and fourth-grade children using computers. The chosen sequence shows Papert, children programming, and a child beside the physical turtle. It does not show Papert and the child handling the turtle together in a single shot.
- No precise filming date is asserted; the catalog page does not specify one.

Copyright remains with the original rights holders. These links document provenance; public availability is not a reuse license, and licensing clearance was not performed.

## 1080p revision

The current export is 1920 × 1080 at 30 fps. Engelbart uses a remastered source; Alto uses extracts from the original AVI. Papert remains limited by MIT’s 320 × 240 source and receives mild temporal denoising and edge sharpening. MP4 uses H.264 CRF 19; WebM uses VP9 CRF 27. No generative upscaling or invented image detail is used. The 720p release is preserved in `edit/original-720p/`.
