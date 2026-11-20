# Disney+ Hebrew dubbing schedule

A Tampermonkey userscript for Disney+ in the browser. It allows Hebrew audio only on selected weekdays (Monday and Thursday by default). On other days it hides the Hebrew audio option and switches the player to English automatically.

## Install

1. Install [Tampermonkey](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo) and, on Chrome 138+, turn on **Allow User Scripts** in the extension's details.
2. Open [disney-dub-schedule.user.js](https://raw.githubusercontent.com/arbiv/disney-dub-schedule/main/disney-dub-schedule.user.js) and click **Install**.

Tampermonkey checks this repo for new versions and updates the script automatically.

Hebrew instructions: [INSTALL_HE.md](INSTALL_HE.md).

## Configuration

At the top of the script:

- `ALLOWED_DAYS`: days when Hebrew is allowed (0 = Sunday ... 6 = Saturday). Default `[1, 4]`.
- `PREFERRED`: the audio language to switch to. Default `English`.
- `DEBUG`: set to `true` to log `[DubSchedule]` lines to the console.

## Testing other days

In the Disney+ tab console:

```js
localStorage.setItem('dubScheduleFakeDay', '5') // act as if today is Friday
localStorage.removeItem('dubScheduleFakeDay')   // back to the real day
```
