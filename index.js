'use strict';

let Service, Characteristic, aesjs, Noble;

module.exports = (api) => {
  // Pull in HAP types from Homebridge API
  Service = api.hap.Service;
  Characteristic = api.hap.Characteristic;

  // BLE and crypto libs
  Noble = require('@abandonware/noble');
  aesjs = require('aes-js');

  // Register accessory
  api.registerAccessory('homebridge-sunset-lamp-ble', 'SunsetLamp', SunsetLamp);
};

class SunsetLamp {
  constructor(log, config) {
    this.log = log;
    this.config = config;
    this.name = config.name || 'Sunset Lamp';
    this.address = (config.ble_address || '').toLowerCase();
    this.peripheral = null;
    this.writeChar = null;
    this.power = false;
    this.hue = 0;
    this.saturation = 0;
    this.brightness = 0;

    // Lightbulb service
    this.lightService = new Service.Lightbulb(this.name);
    this.lightService.getCharacteristic(Characteristic.On)
      .on('set', this.setPower.bind(this))
      .on('get', this.getPower.bind(this));
    this.lightService.getCharacteristic(Characteristic.Brightness)
      .on('set', this.setBrightness.bind(this))
      .on('get', this.getBrightness.bind(this));
    this.lightService.getCharacteristic(Characteristic.Hue)
      .on('set', this.setHue.bind(this))
      .on('get', this.getHue.bind(this));
    this.lightService.getCharacteristic(Characteristic.Saturation)
      .on('set', this.setSaturation.bind(this))
      .on('get', this.getSaturation.bind(this));

    // Start listening for BLE state
    Noble.on('stateChange', this.onStateChange.bind(this));
    Noble.on('scanStop', this.onScanStop.bind(this));
  }

  getServices() {
    const info = new Service.AccessoryInformation();
    info.setCharacteristic(Characteristic.Name, this.name)
        .setCharacteristic(Characteristic.SerialNumber, this.address);
    return [info, this.lightService];
  }

  // Characteristic handlers
  setPower(val, cb)    { this.power = val;    this.writeToLamp(cb); }
  setBrightness(v, cb){ this.brightness = v;  this.writeToLamp(cb); }
  setHue(v, cb)       { this.hue = v;         this.writeToLamp(cb); }
  setSaturation(v, cb){ this.saturation = v;  this.writeToLamp(cb); }
  getPower(cb)        { cb(null, this.power); }
  getBrightness(cb)   { cb(null, this.brightness); }
  getHue(cb)          { cb(null, this.hue); }
  getSaturation(cb)   { cb(null, this.saturation); }

  // BLE lifecycle
  onStateChange(state) {
    if (state === 'poweredOn') {
      this.log.debug('BLE poweredOn, starting scan');
      Noble.on('discover', this.onDiscovered.bind(this));
      Noble.startScanning();
    } else {
      this.log.debug(`BLE state ${state}, stopping scan`);
      Noble.stopScanning();
    }
  }

  onDiscovered(peripheral) {
    if (!this.peripheral && peripheral.address === this.address) {
      this.log.info(`Found lamp ${this.address}, connecting…`);
      this.peripheral = peripheral;
      Noble.stopScanning();
      peripheral.connect(err => this.onConnected(err, peripheral));
    }
  }

  onConnected(err, peripheral) {
    if (err) return this.log.error('Connect failed:', err);
    this.log.debug('Connected, discovering services and characteristics');
    peripheral.discoverSomeServicesAndCharacteristics(
      ['ac501212efde1523785fedbeda25'],
      ['ac521212efde1523785fedbeda25'],
      (err, services, characteristics) => {
        if (err) return this.log.error('Discovery failed:', err);
        this.writeChar = characteristics.find(c => c.uuid === 'ac521212efde1523785fedbeda25');
        if (this.writeChar) this.log.info('Lamp ready! :)');
      }
    );
    peripheral.on('disconnect', () => {
      this.log.debug('Disconnected, clearing and rescanning');
      this.peripheral = null;
      this.writeChar = null;
      Noble.startScanning();
    });
  }

  onScanStop() {
    this.log.debug('BLE scan stopped');
  }

  // Write colour/brightness messages
  writeToLamp(cb) {
    if (!this.writeChar) {
      this.log.warn('No characteristic yet, skipping write');
      return cb(null);
    }
    if (this.power) {
      const {red, green, blue} = this.hsv2rgb(this.hue, this.saturation, this.brightness);
      const colorMsg  = this.encrypt([84,82,0,87,2,1,0,red,green,blue,100,100,0,0,0,0]);
      const brightMsg = this.encrypt([84,82,0,87,7,1,this.brightness,0,0,0,0,0,0,0,0,0]);
      this.writeChar.write(Buffer.from(colorMsg), true);
      this.writeChar.write(Buffer.from(brightMsg), true);
    } else {
      const offMsg = this.encrypt([84,82,0,87,2,1,0,0,0,0,100,100,0,0,0,0]);
      this.writeChar.write(Buffer.from(offMsg), true);
    }
    cb(null);
  }

  encrypt(bytes) {
    const key = Uint8Array.from([0x34,0x52,0x2a,0x5b,0x7a,0x6e,0x49,0x2c,0x08,0x09,0x0a,0x9d,0x8d,0x2a,0x23,0xf8]);
    return new aesjs.ModeOfOperation.ecb(key).encrypt(Uint8Array.from(bytes));
  }

  hsv2rgb(h, s, v) {
    // same helper logic as before...
    h = Math.max(0, Math.min(360, h)); s /= 100; v /= 100;
    if (s === 0) { let c = Math.round(v*255); return {red:c,green:c,blue:c}; }
    h /= 60; let i = Math.floor(h), f = h - i;
    let p = v*(1-s), q = v*(1-s*f), t = v*(1-s*(1-f));
    let [r,g,b] = [v,t,p];
    switch(i) {
      case 1: [r,g,b] = [q,v,p]; break;
      case 2: [r,g,b] = [p,v,t]; break;
      case 3: [r,g,b] = [p,q,v]; break;
      case 4: [r,g,b] = [t,p,v]; break;
      default: break;
    }
    return { red: Math.round(r*255), green: Math.round(g*255), blue: Math.round(b*255) };
  }
}
