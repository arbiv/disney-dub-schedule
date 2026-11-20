# Disney+ audio language schedule

A Tampermonkey userscript for Disney+ in the browser. It allows non-English audio (Hebrew dubbing, Spanish, French, any other language) only on selected weekdays (Monday and Thursday by default). On all other days only English audio is available: every non-English audio option is hidden from the Audio menu, and if the current audio is not English the player is switched to English automatically. A title that has no English audio is left alone. Subtitles are never touched.

## Install

1. Install [Tampermonkey](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo) and, on Chrome 138+, turn on **Allow User Scripts** in the extension's details.
2. Open [disney-dub-schedule.user.js](https://raw.githubusercontent.com/arbiv/disney-dub-schedule/main/disney-dub-schedule.user.js) and click **Install**.

Tampermonkey checks this repo for new versions and updates the script automatically.

Hebrew instructions: [INSTALL_HE.md](INSTALL_HE.md).

## Configuration

At the top of the script:

- `ALLOWED_DAYS`: days when all audio languages are allowed (0 = Sunday ... 6 = Saturday). Default `[1, 4]`. On every other day only English is available.
- `PREFERRED`: the only audio language allowed on restricted days, and the one the script switches to. Default `English`. A row counts as English if its label is, or starts with, `English` (so `English [Audio Description]` stays visible, but the plain `English` row is the one that gets selected).
- `DEBUG`: set to `true` to log `[DubSchedule]` lines to the console.

## Testing other days

In the Disney+ tab console:

```js
localStorage.setItem('dubScheduleFakeDay', '5') // act as if today is Friday
localStorage.removeItem('dubScheduleFakeDay')   // back to the real day
```

## Disclaimer

This is an unofficial, personal project. It is not affiliated with, endorsed by, sponsored by, or connected to The Walt Disney Company, Disney+, or any of their affiliates. "Disney" and "Disney+" are trademarks of their respective owners and are used here only to describe what the script works with.

The script only changes settings in your own browser on your own account: it picks an audio track that Disney+ already offers and hides another option from the menu. It does not download, copy, record, or redistribute any content, and it does not bypass DRM, geo-restrictions, paywalls, or any other access control.

The software is provided "as is", without warranty of any kind, as described in the [LICENSE](LICENSE). Use it at your own risk. You are responsible for making sure your use complies with the Disney+ Terms of Use and any laws that apply to you. The author is not liable for any damage, account action, data loss, or other consequence arising from its use. Disney+ may change its website at any time, which may stop the script from working.

This is not legal advice.
