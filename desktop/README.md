# Call Center

Upload an Excel list of names and phone numbers. Your **Android phone** calls each person, one after another. When you hang up, the next person is called automatically.

The dashboard shows who you are calling **now**, and in small text the person **before** and the person **after**.

Brand colors: purple, yellow, white.

## How it works

```
Browser dashboard  <->  Call Center program (on your computer)  <->  ADB  <->  your Android phone
```

The program runs on your computer and tells your phone to dial through ADB (Google's free Android tool). The calls are made by your phone with your own SIM card, so normal call charges apply.

> iPhone cannot be controlled this way. An Android phone is required.

## One-time setup (about 10 minutes)

1. **Install Node.js** (the free "LTS" version) from nodejs.org.
2. **Get ADB.** Download Google's free *SDK Platform-Tools* for your system, unzip it, and put the folder named `platform-tools` **inside the Call Center folder** (next to `server.js`).
3. **Turn on USB debugging on the phone:** Settings → About phone → tap *Build number* 7 times → Developer options → switch on *USB debugging*.

## Start it

- **Windows:** double-click `start.bat`
- **Mac:** double-click `start.command` (first time: right-click → Open)
- **Linux:** run `./start.sh`

Your browser opens at http://localhost:3000. The first start downloads what the program needs, so it takes a minute.

## Using it

1. **Upload contacts.** Click *Download Excel template* on the dashboard, fill it in, and upload it. Any `.xlsx` or `.csv` with a names column and a phone column works. Numbers like `0712 345 678` or `712345678` become `+255712345678` automatically (change the country code in Settings if you are not in Tanzania).
2. **Connect your phone.**
   - *USB:* plug it in and tap **Allow** on the phone when asked.
   - *Wi-Fi:* phone and computer on the same Wi-Fi → Developer options → *Wireless debugging* → *Pair device with pairing code*. Enter the pairing address and code in the dashboard and press **Pair phone**, then enter the address shown on the main Wireless debugging screen and press **Connect**.
3. Press **Start calling.** Talk, then hang up (on the phone or with the **Hang up** button). After a short pause (default 3 seconds) the next person is called.

Other buttons: **Pause** (stops after the current call), **Stop**, **Skip** (per person in the list), **Retry missed**, **Reset list**, **Export results** (CSV with status and call length).

## Try it without a phone

Start with `--demo` (`npm run demo`) to see everything working with a pretend phone. No real calls are made.

## Good to know

- Android only reports "in a call / not in a call". The program cannot tell whether the person answered, so every finished call is marked **Called** with its length. A call that never starts within 25 seconds is marked **Missed**.
- Only use this to call people who expect your call. Follow your local calling and privacy rules.
- The program only listens on your own computer (`127.0.0.1`), so nobody else on your network can use it.
- Contact lists are saved in the `data` folder on your computer and are not uploaded anywhere.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| "Setup needed" in the top bar | `platform-tools` folder is missing or in the wrong place |
| Phone shows "unauthorized" | Unlock the phone and tap **Allow** on the USB debugging prompt |
| Call does not start | Make sure the phone is unlocked, has signal, and the Phone app has the call permission |
| Port already in use | Close the other Call Center window, or run with `PORT=3001` |
