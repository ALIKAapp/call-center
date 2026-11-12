# Call Center

Upload an Excel list of names and phone numbers. Your **Android phone** calls each person one after another, and when you hang up the next call starts on its own. The dashboard shows who you are calling now, with the person before and the person after in small text.

## Use it (no install)

1. Open the website in **Google Chrome** or **Microsoft Edge** on any computer.
2. On the phone: Settings → About phone → tap *Build number* 7 times → Developer options → turn on **USB debugging**.
3. Plug the phone in with a USB cable, press **Connect phone**, pick it, then tap **Allow** on the phone.
4. Upload your Excel file (or download the template from the page) and press **Start calling**.

Calls go out on the phone's own SIM, so normal call charges apply. The contact list stays in your browser and is never uploaded anywhere.

Want to look around first? Add `?demo` to the address to use a pretend phone.

## Folders

| Folder | What it is |
| --- | --- |
| `docs/` | The live website (served by GitHub Pages) |
| `web/` | Source of the website. `npm install && npm run build` rebuilds `docs/` |
| `desktop/` | Optional desktop version that also supports connecting the phone over **Wi-Fi** (needs Node.js and Google platform-tools; see its README) |

## Good to know

- Android only reports "in a call / not in a call", so a finished call is marked **Called** with its length; whether the person picked up can't be detected. A call that never starts within the time limit is marked **Missed**.
- Keep the Call Center tab open while calling.
- Only call people who expect your call, and follow local calling and privacy rules.
