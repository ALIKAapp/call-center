// Phone adapters. The USB phone talks to Android's debugging service straight from the
// browser with WebUSB, so nothing has to be installed on the computer.
import { Adb, AdbDaemonTransport } from '@yume-chan/adb';
import { AdbDaemonWebUsbDeviceManager } from '@yume-chan/adb-daemon-webusb';
import AdbWebCredentialStore from '@yume-chan/adb-credential-web';

const credentialStore = new AdbWebCredentialStore('Call Center');

export const usbSupported = () => Boolean(AdbDaemonWebUsbDeviceManager.BROWSER);

const friendlyError = (error) => {
  const text = String((error && error.message) || error || '');
  if (/claim|busy|in use|access denied|Unable to claim interface/i.test(text)) {
    return 'The phone is being used by another program on this computer (often "adb" or Android Studio). Close it, unplug the phone, plug it back in and try again.';
  }
  if (/No device selected|cancel/i.test(text)) return 'No phone was chosen.';
  if (/auth|reject|denied/i.test(text)) return 'The phone did not allow the connection. Unlock it and tap "Allow" on the USB debugging message.';
  return text || 'Could not connect to the phone.';
};

export const createUsbPhone = ({ onChange }) => {
  const manager = AdbDaemonWebUsbDeviceManager.BROWSER;
  const phone = {
    mode: 'usb',
    adb: null,
    name: '',
    connecting: false,
    get ready() {
      return Boolean(this.adb);
    },

    async open(device) {
      this.connecting = true;
      onChange();
      try {
        const connection = await device.connect();
        const transport = await AdbDaemonTransport.authenticate({
          serial: device.serial,
          connection,
          credentialStore,
        });
        this.adb = new Adb(transport);
        let model = '';
        try {
          model = (await this.shell('getprop ro.product.model')).trim();
        } catch {
          /* model name is only cosmetic */
        }
        this.name = model || device.name || 'Android phone';
        this.adb.disconnected.then(() => {
          this.adb = null;
          onChange({ lost: true });
        });
        return { ok: true };
      } catch (error) {
        this.adb = null;
        return { ok: false, error: friendlyError(error) };
      } finally {
        this.connecting = false;
        onChange();
      }
    },

    async choose() {
      let device;
      try {
        device = await manager.requestDevice();
      } catch (error) {
        return { ok: false, error: friendlyError(error) };
      }
      if (!device) return { ok: false, error: 'No phone was chosen.' };
      return this.open(device);
    },

    // Reconnect silently to a phone this browser was already allowed to use.
    async reconnect() {
      if (this.adb || this.connecting) return { ok: true };
      const devices = await manager.getDevices();
      if (devices.length !== 1) return { ok: false };
      return this.open(devices[0]);
    },

    async disconnect() {
      const adb = this.adb;
      this.adb = null;
      if (adb) await adb.close().catch(() => {});
      onChange();
    },

    shell(command) {
      if (!this.adb) return Promise.reject(new Error('No phone connected.'));
      return this.adb.subprocess.noneProtocol.spawnWaitText(command);
    },

    requireDevice() {
      return this.adb ? null : 'Connect your phone first (step 2).';
    },

    async dial(number) {
      try {
        const out = await this.shell(`am start -a android.intent.action.CALL -d tel:${encodeURIComponent(number)}`);
        if (/error|exception|permission denial/i.test(out)) return { ok: false, error: out.trim().split('\n').slice(0, 2).join(' ') };
        return { ok: true };
      } catch (error) {
        return { ok: false, error: friendlyError(error) };
      }
    },

    async hangup() {
      try {
        await this.shell('input keyevent KEYCODE_ENDCALL');
      } catch {
        /* phone may already be gone */
      }
    },

    // 0 = idle, 1 = ringing, 2 = in a call (dialing counts as in a call). null = could not read.
    async callState() {
      try {
        const out = await this.shell('dumpsys telephony.registry');
        const states = [...out.matchAll(/mCallState\s*=\s*(\d)/g)].map((m) => Number(m[1]));
        return states.length ? Math.max(...states) : null;
      } catch {
        return null;
      }
    },
  };

  if (navigator.usb) {
    navigator.usb.addEventListener('connect', () => phone.reconnect());
  }
  return phone;
};

export const createDemoPhone = () => ({
  mode: 'demo',
  name: 'Demo phone (no real calls)',
  ready: true,
  connecting: false,
  callEndsAt: 0,
  async choose() {
    return { ok: true };
  },
  async reconnect() {
    return { ok: true };
  },
  async disconnect() {},
  requireDevice() {
    return null;
  },
  async dial() {
    this.callEndsAt = Date.now() + 3500 + Math.random() * 3500;
    return { ok: true };
  },
  async hangup() {
    this.callEndsAt = 0;
  },
  async callState() {
    return Date.now() < this.callEndsAt ? 2 : 0;
  },
});
