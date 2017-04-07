/* eslint-disable camelcase */
'use strict';

const debug = require('debug')('wireless');
const PromiseA = require('bluebird');
const EventEmitter = require('eventemitter2').EventEmitter2;
const {exec} = require('child-process-promise');
const iwlist = require('wireless-tools/iwlist');
const ifconfig = require('wireless-tools/ifconfig');

const utils = require('./utils');
const WPA = require('./wpa');

/**
 *
 */
class Wireless extends EventEmitter {

  constructor(iface) {
    super({wildcard: true});
    iface = iface || 'wlan0';
    this.iface = iface;
    this.wpa = new WPA(iface);

    const that = this;
    this.wpa.on('*', function () {
      that.emit(this.event, ...arguments);
    });
  }

  _updateNetworks() {
    return this.listNetworks().then(networks => this._networks = networks);
  }

  open() {
    return this.wpa.open()
      .then(() => this.listNetworks())
      .then(networks => this._networks = networks);
  }

  close() {
    return this.wpa.close();
  }

  status() {
    return this.wpa.status();
  }

  /**
   * Resile could be one of: '', 'station', 'ap', and 'unknown'
   */
  mode() {
    return this.wpa.status().then(status => {
      if (status.mode) {
        return status.mode; // should be 'station'
      }
      if (utils.toLower(status.wpa_state) === 'disconnected') {
        return status.ip_address ? 'ap' : '';
      }
      return 'unknown';
    });
  }

  scan() {
    return new PromiseA.fromCallback(cb => iwlist.scan(this.iface, cb)).then(networks => {
      debug(`Found ${networks.length} wireless networks at ${this.iface}`);
      this.emit('scan_result', networks);
      return networks;
    });
  }

  /**
   * List network interfaces on system
   */
  listInterfaces() {
    return PromiseA.fromCallback(cb => ifconfig.status(cb));
  }

  listNetworks() {
    return this.wpa.listNetworks();
  }

  findNetworkBySsid(ssid) {
    return PromiseA.resolve(this._networks ? this._networks : this._updateNetworks())
      .then(networks => networks.find(n => n.ssid === ssid));
  }

  // eslint-disable-next-line no-unused-vars
  connect(ssid, password, options) {
    return this.addOrUpdateNetwork(...arguments);
  }

  disconnect() {
    return this.wpa.disconnect();
  }

  addOrUpdateNetwork(ssid, password, options) {
    options = options || {};
    const {auth} = options;
    const data = {ssid, psk: password};
    if (password) {
      data.key_mgmt = 'WPA-PSK';
    } else {
      data.key_mgmt = 'NONE';
      if (auth === 'WEP' || (password && !auth)) {
        data.wep_tx_keyidx = 0;
        data.wep_key0 = password;
      }
    }
    data.scan_ssid = 1;

    const wpa = this.wpa;
    const keys = Object.keys(data);
    const quotedSsid = `"${ssid}"`;
    debug('connect', data);
    return this.findNetworkBySsid(ssid)
      .then(network => network ? network.id : wpa.addNetwork())
      .then(id => {
        return PromiseA.mapSeries(keys, key => {
          if (['ssid', 'psk'].includes(key)) {
            return wpa.setNetworkSettingString(id, key, data[key]);
          }
          return wpa.setNetworkSetting(id, key, data[key]);
        })
          .then(() => wpa.enableNetwork(id))
          .then(() => wpa.selectNetwork(id))
          .then(() => wpa.saveConfiguration());
      })
      .then(() => this._updateNetworks())
      .then(networks => networks.find(n => n.ssid === ssid || n.ssid === quotedSsid));
  }

  removeNetwork(ssid) {
    return this.findNetworkBySsid(ssid).then(n => n && this.wpa.removeNetwork(n.id));
  }

  enableNetworks(ssid) {
    return this.findNetworkBySsid(ssid).then(n => n && this.wpa.enableNetwork(n.id));
  }

  disableNetwork(ssid) {
    return this.findNetworkBySsid(ssid).then(n => n && this.wpa.disableNetwork(n.id));
  }

  selectNetwork(ssid) {
    return this.findNetworkBySsid(ssid).then(n => n && this.wpa.selectNetwork(n.id));
  }

  reloadConfiguration() {
    return this.wpa.reloadConfiguration();
  }

  saveConfiguration() {
    return this.wpa.saveConfiguration();
  }

  detect() {
    function check(result) {
      const {stdout} = result;

      if (stdout.indexOf('802.11') >= 0) {
        return '802.11';
      } else if (stdout.toUpperCase().indexOf('WLAN') >= 0) {
        return 'WLAN';
      }
      return false;
    }

    return PromiseA.filter(['lsusb', 'iwconfig'], which).then(commands => {
      return new PromiseA((resolve) => {
        let index = 0;

        function next() {
          const cmd = commands[index++];
          if (!cmd) {
            return resolve(null);
          }
          exec(cmd)
            .then(check)
            .then(found => {
              if (found) return resolve({device: found});
              next();
            })
            .catch(next);
        }

        next();
      });
    }).then(data => {
      this.emit('detect', data);
      return data;
    });
  }

  up() {
    debug('ifup...');
    return PromiseA.try(() => exec(`ifup ${this.iface} up`))
      .then(exec(`ifconfig ${this.iface} up`))
      .then(() => {
        debug('ifup successful');
        this.emit('ifup');
      });
  }

  down() {
    debug('ifdown...');
    return PromiseA.try(() => exec(`ifdown ${this.iface} down`))
      .then(exec(`ifconfig ${this.iface} down`))
      .then(() => {
        debug('ifdown successful');
        this.emit('ifdown');
      });
  }

  reboot(delay = 1000) {
    debug('ifreboot...');
    return this.down(this.iface)
      .delay(delay)
      .then(() => this.up(this.iface)).then(() => {
        debug('ifreboot successful');
        this.emit('ifreboot');
      });
  }
}

function which(cmd) {
  return exec(`which ${cmd}`).then(result => result.stdout).catch(() => false);
}

module.exports = Wireless;