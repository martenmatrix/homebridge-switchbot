/* Copyright(C) 2021-2024, donavanbecker (https://github.com/donavanbecker). All rights reserved.
 *
 * ceilinglight.ts: @switchbot/homebridge-switchbot.
 */
import { request } from 'undici';
import { deviceBase } from './device.js';
import { interval, Subject } from 'rxjs';
import { Devices } from '../settings.js';
import { hs2rgb, rgb2hs, m2hs } from '../utils.js';
import { debounceTime, skipWhile, take, tap } from 'rxjs/operators';

import type { SwitchBotPlatform } from '../platform.js';
import type { device, devicesConfig, serviceData, deviceStatus } from '../settings.js';
import type { Service, PlatformAccessory, CharacteristicValue, ControllerConstructor, Controller, ControllerServiceMap } from 'homebridge';

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class CeilingLight extends deviceBase {
  // Services
  private LightBulb: {
    Name: CharacteristicValue;
    Service: Service;
    On: CharacteristicValue;
    Hue: CharacteristicValue;
    Saturation: CharacteristicValue;
    Brightness: CharacteristicValue;
    ColorTemperature?: CharacteristicValue;
  };

  // Adaptive Lighting
  AdaptiveLightingController?: ControllerConstructor | Controller<ControllerServiceMap>;
  adaptiveLightingShift?: number;

  // Updates
  ceilingLightUpdateInProgress!: boolean;
  doCeilingLightUpdate!: Subject<void>;

  constructor(
    readonly platform: SwitchBotPlatform,
    accessory: PlatformAccessory,
    device: device & devicesConfig,
  ) {
    super(platform, accessory, device);
    // default placeholders
    this.adaptiveLighting(device);

    // this is subject we use to track when we need to POST changes to the SwitchBot API
    this.doCeilingLightUpdate = new Subject();
    this.ceilingLightUpdateInProgress = false;

    // Initialize LightBulb Service
    accessory.context.LightBulb = accessory.context.LightBulb ?? {};
    this.LightBulb = {
      Name: accessory.context.LightBul.bName ?? accessory.displayName,
      Service: accessory.getService(this.hap.Service.Lightbulb) ?? accessory.addService(this.hap.Service.Lightbulb) as Service,
      On: accessory.context.On ?? false,
      Hue: accessory.context.Hue ?? 0,
      Saturation: accessory.context.Saturation ?? 0,
      Brightness: accessory.context.Brightness ?? 0,
      ColorTemperature: accessory.context.ColorTemperature ?? 140,
    };
    accessory.context.LightBulb = this.LightBulb as object;

    // Adaptive Lighting
    if (this.adaptiveLightingShift === -1 && accessory.context.adaptiveLighting) {
      accessory.removeService(this.LightBulb.Service);
      this.LightBulb.Service = accessory.addService(this.hap.Service.Lightbulb);
      accessory.context.adaptiveLighting = false;
      this.debugLog(`${device.deviceType}: ${accessory.displayName} adaptiveLighting: ${accessory.context.adaptiveLighting}`);
    }
    if (this.adaptiveLightingShift !== -1) {
      this.AdaptiveLightingController = new platform.api.hap.AdaptiveLightingController(this.LightBulb.Service, {
        customTemperatureAdjustment: this.adaptiveLightingShift,
      });
      this.accessory.configureController(this.AdaptiveLightingController);
      this.accessory.context.adaptiveLighting = true;
      this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} adaptiveLighting: ${this.accessory.context.adaptiveLighting},`
        + ` adaptiveLightingShift: ${this.adaptiveLightingShift}`);
    }
    this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} adaptiveLightingShift: ${this.adaptiveLightingShift}`);

    // Initialize LightBulb Characteristics
    this.LightBulb.Service
      .setCharacteristic(this.hap.Characteristic.Name, this.LightBulb.Name)
      .getCharacteristic(this.hap.Characteristic.On)
      .onGet(() => {
        return this.LightBulb.On;
      })
      .onSet(this.OnSet.bind(this));

    // Initialize LightBulb Brightness
    this.LightBulb.Service
      .getCharacteristic(this.hap.Characteristic.Brightness)
      .setProps({
        minStep: device.ceilinglight?.set_minStep ?? 1,
        minValue: 0,
        maxValue: 100,
        validValueRanges: [0, 100],
      })
      .onGet(() => {
        return this.LightBulb.Brightness;
      })
      .onSet(this.BrightnessSet.bind(this));

    // Initialize LightBulb ColorTemperature
    this.LightBulb.Service
      .getCharacteristic(this.hap.Characteristic.ColorTemperature)
      .setProps({
        minValue: 140,
        maxValue: 500,
        validValueRanges: [140, 500],
      })
      .onGet(() => {
        return this.LightBulb.ColorTemperature!;
      })
      .onSet(this.ColorTemperatureSet.bind(this));

    // Initialize LightBulb Hue
    this.LightBulb.Service
      .getCharacteristic(this.hap.Characteristic.Hue)
      .setProps({
        minValue: 0,
        maxValue: 360,
        validValueRanges: [0, 360],
      })
      .onGet(() => {
        return this.LightBulb.Hue;
      })
      .onSet(this.HueSet.bind(this));

    // Initialize LightBulb Saturation
    this.LightBulb.Service
      .getCharacteristic(this.hap.Characteristic.Saturation)
      .setProps({
        minValue: 0,
        maxValue: 100,
        validValueRanges: [0, 100],
      })
      .onGet(() => {
        return this.LightBulb.Saturation;
      })
      .onSet(this.SaturationSet.bind(this));

    // Retrieve initial values and updateHomekit
    this.refreshStatus();

    // Update Homekit
    this.updateHomeKitCharacteristics();

    // Start an update interval
    interval(this.deviceRefreshRate * 1000)
      .pipe(skipWhile(() => this.ceilingLightUpdateInProgress))
      .subscribe(async () => {
        await this.refreshStatus();
      });

    //regisiter webhook event handler
    this.registerWebhook(accessory, device);

    // Watch for Bulb change events
    // We put in a debounce of 100ms so we don't make duplicate calls
    this.doCeilingLightUpdate
      .pipe(
        tap(() => {
          this.ceilingLightUpdateInProgress = true;
        }),
        debounceTime(this.devicePushRate * 1000),
      )
      .subscribe(async () => {
        try {
          await this.pushChanges();
        } catch (e: any) {
          this.apiError(e);
          this.errorLog(`${this.device.deviceType}: ${this.accessory.displayName} failed pushChanges with ${this.device.connectionType} Connection,`
            + ` Error Message: ${JSON.stringify(e.message)}`);
        }
        this.ceilingLightUpdateInProgress = false;
      });
  }

  /**
   * Parse the device status from the SwitchBotBLE API
   */
  async BLEparseStatus(serviceData: serviceData): Promise<void> {
    this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} BLEparseStatus`);
    // State
    switch (serviceData.state) {
      case 'on':
        this.LightBulb.On = true;
        break;
      default:
        this.LightBulb.On = false;
    }
    this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} On: ${this.LightBulb.On}`);
  }

  /**
   * Parse the device status from the SwitchBot OpenAPI
   */
  async openAPIparseStatus(deviceStatus: deviceStatus) {
    this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} openAPIparseStatus`);
    switch (deviceStatus.body.power) {
      case 'on':
        this.LightBulb.On = true;
        break;
      default:
        this.LightBulb.On = false;
    }
    this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} On: ${this.LightBulb.On}`);

    // Brightness
    this.LightBulb.Brightness = Number(deviceStatus.body.brightness);
    this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} Brightness: ${this.LightBulb.Brightness}`);

    // Color, Hue & Brightness
    if (deviceStatus.body.color) {
      this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} color: ${JSON.stringify(deviceStatus.body.color)}`);
      const [red, green, blue] = deviceStatus.body.color!.split(':');
      this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} red: ${JSON.stringify(red)}`);
      this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} green: ${JSON.stringify(green)}`);
      this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} blue: ${JSON.stringify(blue)}`);

      const [hue, saturation] = rgb2hs(Number(red), Number(green), Number(blue));
      this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName}`
        + ` hs: ${JSON.stringify(rgb2hs(Number(red), Number(green), Number(blue)))}`);

      // Hue
      this.LightBulb.Hue = hue;
      this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} Hue: ${this.LightBulb.Hue}`);

      // Saturation
      this.LightBulb.Saturation = saturation;
      this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} Saturation: ${this.LightBulb.Saturation}`);
    }

    // ColorTemperature
    if (!Number.isNaN(deviceStatus.body.colorTemperature)) {
      this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} OpenAPI ColorTemperature: ${deviceStatus.body.colorTemperature}`);
      const mired = Math.round(1000000 / deviceStatus.body.colorTemperature!);

      this.LightBulb.ColorTemperature = Number(mired);

      this.LightBulb.ColorTemperature = Math.max(Math.min(this.LightBulb.ColorTemperature, 500), 140);
      this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} ColorTemperature: ${this.LightBulb.ColorTemperature}`);
    }

    // Firmware Version
    const version = deviceStatus.body.version?.toString();
    this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} Firmware Version: ${version?.replace(/^V|-.*$/g, '')}`);
    if (deviceStatus.body.version) {
      const deviceVersion = version?.replace(/^V|-.*$/g, '') ?? '0.0.0';
      this.accessory
        .getService(this.hap.Service.AccessoryInformation)!
        .setCharacteristic(this.hap.Characteristic.HardwareRevision, deviceVersion)
        .setCharacteristic(this.hap.Characteristic.FirmwareRevision, deviceVersion)
        .getCharacteristic(this.hap.Characteristic.FirmwareRevision)
        .updateValue(deviceVersion);
      this.accessory.context.deviceVersion = deviceVersion;
      this.debugSuccessLog(`${this.device.deviceType}: ${this.accessory.displayName} deviceVersion: ${this.accessory.context.deviceVersion}`);
    }
  }

  /**
   * Asks the SwitchBot API for the latest device information
   */
  async refreshStatus(): Promise<void> {
    if (!this.device.enableCloudService && this.OpenAPI) {
      this.errorLog(`${this.device.deviceType}: ${this.accessory.displayName} refreshStatus enableCloudService: ${this.device.enableCloudService}`);
      /*} else if (this.BLE) {
        await this.BLERefreshStatus();*/
    } else if (this.OpenAPI && this.platform.config.credentials?.token) {
      await this.openAPIRefreshStatus();
    } else {
      await this.offlineOff();
      this.debugWarnLog(`${this.device.deviceType}: ${this.accessory.displayName} Connection Type:`
        + ` ${this.device.connectionType}, refreshStatus will not happen.`);
    }
  }

  async BLERefreshStatus(): Promise<void> {
    this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} BLERefreshStatus`);
    const switchbot = await this.platform.connectBLE();
    // Convert to BLE Address
    this.device.bleMac = this.device
      .deviceId!.match(/.{1,2}/g)!
      .join(':')
      .toLowerCase();
    this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} BLE Address: ${this.device.bleMac}`);
    this.getCustomBLEAddress(switchbot);
    // Start to monitor advertisement packets
    (async () => {
      // Start to monitor advertisement packets
      await switchbot.startScan({ model: this.device.bleModel, id: this.device.bleMac });
      // Set an event handler
      switchbot.onadvertisement = (ad: any) => {
        if (this.device.bleMac === ad.address && ad.model === this.device.bleModel) {
          this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} ${JSON.stringify(ad, null, '  ')}`);
          this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} address: ${ad.address}, model: ${ad.model}`);
          this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} serviceData: ${JSON.stringify(ad.serviceData)}`);
        } else {
          this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} serviceData: ${JSON.stringify(ad.serviceData)}`);
        }
      };
      // Wait 10 seconds
      await switchbot.wait(this.scanDuration * 1000);
      // Stop to monitor
      await switchbot.stopScan();
      // Update HomeKit
      await this.BLEparseStatus(switchbot.onadvertisement.serviceData);
      await this.updateHomeKitCharacteristics();
    })();
    if (switchbot === undefined) {
      await this.BLERefreshConnection(switchbot);
    }
  }

  async openAPIRefreshStatus(): Promise<void> {
    this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} openAPIRefreshStatus`);
    try {
      const { body, statusCode } = await this.platform.retryRequest(this.deviceMaxRetries, this.deviceDelayBetweenRetries,
        `${Devices}/${this.device.deviceId}/status`, { headers: this.platform.generateHeaders() });
      this.debugWarnLog(`${this.device.deviceType}: ${this.accessory.displayName} statusCode: ${statusCode}`);
      const deviceStatus: any = await body.json();
      this.debugWarnLog(`${this.device.deviceType}: ${this.accessory.displayName} deviceStatus: ${JSON.stringify(deviceStatus)}`);
      this.debugWarnLog(`${this.device.deviceType}: ${this.accessory.displayName} deviceStatus statusCode: ${deviceStatus.statusCode}`);
      if ((statusCode === 200 || statusCode === 100) && (deviceStatus.statusCode === 200 || deviceStatus.statusCode === 100)) {
        this.debugSuccessLog(`${this.device.deviceType}: ${this.accessory.displayName} `
          + `statusCode: ${statusCode} & deviceStatus StatusCode: ${deviceStatus.statusCode}`);
        this.openAPIparseStatus(deviceStatus);
        this.updateHomeKitCharacteristics();
      } else {
        this.statusCode(statusCode);
        this.statusCode(deviceStatus.statusCode);
      }
    } catch (e: any) {
      this.apiError(e);
      this.errorLog(`${this.device.deviceType}: ${this.accessory.displayName} failed openAPIRefreshStatus with ${this.device.connectionType}`
        + ` Connection, Error Message: ${JSON.stringify(e.message)}`);
    }
  }

  async registerWebhook(accessory: PlatformAccessory, device: device & devicesConfig) {
    if (device.webhook) {
      this.debugLog(`${device.deviceType}: ${accessory.displayName} is listening webhook.`);
      this.platform.webhookEventHandler[device.deviceId] = async (context) => {
        try {
          this.debugLog(`${device.deviceType}: ${accessory.displayName} received Webhook: ${JSON.stringify(context)}`);
          const { powerState, brightness, colorTemperature } = context;
          const { On, Brightness, ColorTemperature } = this.LightBulb;
          this.debugLog(`${device.deviceType}: ${accessory.displayName} ` +
            '(powerState, brightness, colorTemperature) = ' +
            `Webhook:(${powerState}, ${brightness}, ${colorTemperature}), `
            + `current:(${On}, ${Brightness}, ${ColorTemperature})`);

          // On
          this.LightBulb.On = powerState === 'ON' ? true : false;
          if (accessory.context.Brightness !== this.LightBulb.On) {
            this.infoLog(`${device.deviceType}: ${accessory.displayName} On: ${this.LightBulb.On}`);
          } else {
            this.debugLog(`${device.deviceType}: ${accessory.displayName} On: ${this.LightBulb.On}`);
          }

          // Brightness
          this.LightBulb.Brightness = brightness;
          if (accessory.context.Brightness !== this.LightBulb.Brightness) {
            this.infoLog(`${device.deviceType}: ${accessory.displayName} Brightness: ${this.LightBulb.Brightness}`);
          } else {
            this.debugLog(`${device.deviceType}: ${accessory.displayName} Brightness: ${this.LightBulb.Brightness}`);
          }

          // ColorTemperature
          this.LightBulb.ColorTemperature = colorTemperature;
          if (accessory.context.ColorTemperature !== this.LightBulb.ColorTemperature) {
            this.infoLog(`${device.deviceType}: ${accessory.displayName} ColorTemperature: ${this.LightBulb.ColorTemperature}`);
          } else {
            this.debugLog(`${device.deviceType}: ${accessory.displayName} ColorTemperature: ${this.LightBulb.ColorTemperature}`);
          }
          this.updateHomeKitCharacteristics();
        } catch (e: any) {
          this.errorLog(`${device.deviceType}: ${accessory.displayName} `
            + `failed to handle webhook. Received: ${JSON.stringify(context)} Error: ${e}`);
        }
      };
    } else {
      this.debugLog(`${device.deviceType}: ${accessory.displayName} is not listening webhook.`);
    }
  }

  /**
   * Pushes the requested changes to the SwitchBot API
   * deviceType	      commandType	          Command	               command parameter	                     Description
   * Color Bulb   -    "command"            "turnOff"                  "default"	              =        set to OFF state
   * Color Bulb   -    "command"            "turnOn"                   "default"	              =        set to ON state
   * Color Bulb   -    "command"            "toggle"                   "default"	              =        toggle state
   * Color Bulb   -    "command"         "setBrightness"	             "{1-100}"	              =        set brightness
   * Color Bulb   -    "command"           "setColor"	         "{0-255}:{0-255}:{0-255}"	      =        set RGB color value
   * Color Bulb   -    "command"     "setColorTemperature"	         "{2700-6500}"	            =        set color temperature
   *
   */
  async pushChanges(): Promise<void> {
    if (!this.device.enableCloudService && this.OpenAPI) {
      this.errorLog(`${this.device.deviceType}: ${this.accessory.displayName} pushChanges enableCloudService: ${this.device.enableCloudService}`);
      /*} else if (this.BLE) {
        await this.BLEpushChanges();*/
    } else if (this.OpenAPI && this.platform.config.credentials?.token) {
      await this.openAPIpushChanges();
    } else {
      await this.offlineOff();
      this.debugWarnLog(`${this.device.deviceType}: ${this.accessory.displayName} Connection Type:`
        + ` ${this.device.connectionType}, pushChanges will not happen.`);
    }
    // Refresh the status from the API
    interval(15000)
      .pipe(skipWhile(() => this.ceilingLightUpdateInProgress))
      .pipe(take(1))
      .subscribe(async () => {
        await this.refreshStatus();
      });
  }

  async BLEpushChanges(): Promise<void> {
    this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} BLEpushChanges`);
    if (this.LightBulb.On !== this.accessory.context.On) {
      this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName}`
        + ` BLEpushChanges On: ${this.LightBulb.On} OnCached: ${this.accessory.context.On}`);
      const switchbot = await this.platform.connectBLE();
      // Convert to BLE Address
      this.device.bleMac = this.device
        .deviceId!.match(/.{1,2}/g)!
        .join(':')
        .toLowerCase();
      this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} BLE Address: ${this.device.bleMac}`);
      switchbot
        .discover({
          model: 'u',
          id: this.device.bleMac,
        })
        .then(async (device_list: any) => {
          this.infoLog(`${this.device.deviceType}: ${this.accessory.displayName} On: ${this.LightBulb.On}`);
          return await this.retryBLE({
            max: await this.maxRetryBLE(),
            fn: async () => {
              if (this.LightBulb.On) {
                return await device_list[0].turnOn({ id: this.device.bleMac });
              } else {
                return await device_list[0].turnOff({ id: this.device.bleMac });
              }
            },
          });
        })
        .then(() => {
          this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} Done.`);
          this.successLog(`${this.device.deviceType}: ${this.accessory.displayName} `
            + `On: ${this.LightBulb.On} sent over BLE,  sent successfully`);
          this.LightBulb.On = false;
        })
        .catch(async (e: any) => {
          this.apiError(e);
          this.errorLog(`${this.device.deviceType}: ${this.accessory.displayName} failed BLEpushChanges with ${this.device.connectionType}`
            + ` Connection, Error Message: ${JSON.stringify(e.message)}`);
          await this.BLEPushConnection();
        });
    } else {
      this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName}`
        + ` No BLEpushChanges: On: ${this.LightBulb.On}, `
        + `OnCached: ${this.accessory.context.On}`);
    }
  }

  async openAPIpushChanges(): Promise<void> {
    this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} openAPIpushChanges`);
    if (this.LightBulb.On !== this.accessory.context.On) {
      let command = '';
      if (this.LightBulb.On) {
        command = 'turnOn';
      } else {
        command = 'turnOff';
      }
      const bodyChange = JSON.stringify({
        command: `${command}`,
        parameter: 'default',
        commandType: 'command',
      });
      this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} Sending request to SwitchBot API, body: ${bodyChange},`);
      try {
        const { body, statusCode } = await request(`${Devices}/${this.device.deviceId}/commands`, {
          body: bodyChange,
          method: 'POST',
          headers: this.platform.generateHeaders(),
        });
        this.debugWarnLog(`${this.device.deviceType}: ${this.accessory.displayName} statusCode: ${statusCode}`);
        const deviceStatus: any = await body.json();
        this.debugWarnLog(`${this.device.deviceType}: ${this.accessory.displayName} deviceStatus: ${JSON.stringify(deviceStatus)}`);
        this.debugWarnLog(`${this.device.deviceType}: ${this.accessory.displayName} deviceStatus body: ${JSON.stringify(deviceStatus.body)}`);
        this.debugWarnLog(`${this.device.deviceType}: ${this.accessory.displayName} deviceStatus statusCode: ${deviceStatus.statusCode}`);
        if ((statusCode === 200 || statusCode === 100) && (deviceStatus.statusCode === 200 || deviceStatus.statusCode === 100)) {
          this.debugSuccessLog(`${this.device.deviceType}: ${this.accessory.displayName} `
            + `statusCode: ${statusCode} & deviceStatus StatusCode: ${deviceStatus.statusCode}`);
          this.successLog(`${this.device.deviceType}: ${this.accessory.displayName} `
            + `request to SwitchBot API, body: ${JSON.stringify(JSON.parse(bodyChange))} sent successfully`);
        } else {
          this.statusCode(statusCode);
          this.statusCode(deviceStatus.statusCode);
        }
      } catch (e: any) {
        this.apiError(e);
        this.errorLog(`${this.device.deviceType}: ${this.accessory.displayName} failed openAPIpushChanges with ${this.device.connectionType}`
          + ` Connection, Error Message: ${JSON.stringify(e.message)}`);
      }
    } else {
      this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} No openAPIpushChanges.`
        + `On: ${this.LightBulb.On}, `
        + `OnCached: ${this.accessory.context.On}`);
    }
    // Push Hue & Saturation Update
    if (this.LightBulb.On) {
      await this.pushHueSaturationChanges();
    }
    // Push ColorTemperature Update
    if (this.LightBulb.On) {
      await this.pushColorTemperatureChanges();
    }
    // Push Brightness Update
    if (this.LightBulb.On) {
      await this.pushBrightnessChanges();
    }
  }

  async pushHueSaturationChanges(): Promise<void> {
    this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} pushHueSaturationChanges`);
    if (this.LightBulb.Hue !== this.accessory.context.Hue || this.LightBulb.Saturation !== this.accessory.context.Saturation) {
      this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} Hue: ${JSON.stringify(this.LightBulb.Hue)}`);
      this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} Saturation: ${JSON.stringify(this.LightBulb.Saturation)}`);
      const [red, green, blue] = hs2rgb(Number(this.LightBulb.Hue), Number(this.LightBulb.Saturation));
      this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} rgb: ${JSON.stringify([red, green, blue])}`);
      const bodyChange = JSON.stringify({
        command: 'setColor',
        parameter: `${red}:${green}:${blue}`,
        commandType: 'command',
      });
      this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} Sending request to SwitchBot API, body: ${bodyChange},`);
      try {
        const { body, statusCode } = await request(`${Devices}/${this.device.deviceId}/commands`, {
          body: bodyChange,
          method: 'POST',
          headers: this.platform.generateHeaders(),
        });
        this.debugWarnLog(`${this.device.deviceType}: ${this.accessory.displayName} statusCode: ${statusCode}`);
        const deviceStatus: any = await body.json();
        this.debugWarnLog(`${this.device.deviceType}: ${this.accessory.displayName} deviceStatus: ${JSON.stringify(deviceStatus)}`);
        this.debugWarnLog(`${this.device.deviceType}: ${this.accessory.displayName} deviceStatus body: ${JSON.stringify(deviceStatus.body)}`);
        this.debugWarnLog(`${this.device.deviceType}: ${this.accessory.displayName} deviceStatus statusCode: ${deviceStatus.statusCode}`);
        if ((statusCode === 200 || statusCode === 100) && (deviceStatus.statusCode === 200 || deviceStatus.statusCode === 100)) {
          this.debugSuccessLog(`${this.device.deviceType}: ${this.accessory.displayName} `
            + `statusCode: ${statusCode} & deviceStatus StatusCode: ${deviceStatus.statusCode}`);
          this.successLog(`${this.device.deviceType}: ${this.accessory.displayName} `
            + `request to SwitchBot API, body: ${JSON.stringify(JSON.parse(bodyChange))} sent successfully`);
        } else {
          this.statusCode(statusCode);
          this.statusCode(deviceStatus.statusCode);
        }
      } catch (e: any) {
        this.apiError(e);
        this.errorLog(`${this.device.deviceType}: ${this.accessory.displayName} failed pushHueSaturationChanges with ${this.device.connectionType}`
          + ` Connection, Error Message: ${JSON.stringify(e.message)}`);
      }
    } else {
      this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} No pushHueSaturationChanges. Hue: ${this.LightBulb.Hue}, HueCached: `
        + `${this.accessory.context.Hue}, Saturation: ${this.LightBulb.Saturation}, SaturationCached: ${this.accessory.context.Saturation}`);
    }
  }

  async pushColorTemperatureChanges(): Promise<void> {
    this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} pushColorTemperatureChanges`);
    if (this.LightBulb.ColorTemperature !== this.accessory.context.ColorTemperature) {
      const kelvin = Math.round(1000000 / Number(this.LightBulb.ColorTemperature));
      this.accessory.context.kelvin = kelvin;
      const bodyChange = JSON.stringify({
        command: 'setColorTemperature',
        parameter: `${kelvin}`,
        commandType: 'command',
      });
      this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} Sending request to SwitchBot API, body: ${bodyChange},`);
      try {
        const { body, statusCode } = await request(`${Devices}/${this.device.deviceId}/commands`, {
          body: bodyChange,
          method: 'POST',
          headers: this.platform.generateHeaders(),
        });
        this.debugWarnLog(`${this.device.deviceType}: ${this.accessory.displayName} statusCode: ${statusCode}`);
        const deviceStatus: any = await body.json();
        this.debugWarnLog(`${this.device.deviceType}: ${this.accessory.displayName} deviceStatus: ${JSON.stringify(deviceStatus)}`);
        this.debugWarnLog(`${this.device.deviceType}: ${this.accessory.displayName} deviceStatus body: ${JSON.stringify(deviceStatus.body)}`);
        this.debugWarnLog(`${this.device.deviceType}: ${this.accessory.displayName} deviceStatus statusCode: ${deviceStatus.statusCode}`);
        if ((statusCode === 200 || statusCode === 100) && (deviceStatus.statusCode === 200 || deviceStatus.statusCode === 100)) {
          this.debugSuccessLog(`${this.device.deviceType}: ${this.accessory.displayName} `
            + `statusCode: ${statusCode} & deviceStatus StatusCode: ${deviceStatus.statusCode}`);
        } else {
          this.statusCode(statusCode);
          this.statusCode(deviceStatus.statusCode);
        }
      } catch (e: any) {
        this.apiError(e);
        this.errorLog(`${this.device.deviceType}: ${this.accessory.displayName} failed pushColorTemperatureChanges with`
          + ` ${this.device.connectionType} Connection, Error Message: ${JSON.stringify(e.message)}`);
      }
    } else {
      this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} No pushColorTemperatureChanges.`
        + `ColorTemperature: ${this.LightBulb.ColorTemperature}, ColorTemperatureCached: ${this.accessory.context.ColorTemperature}`);
    }
  }

  async pushBrightnessChanges(): Promise<void> {
    this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} pushBrightnessChanges`);
    if (this.LightBulb.Brightness !== this.accessory.context.Brightness) {
      const bodyChange = JSON.stringify({
        command: 'setBrightness',
        parameter: `${this.LightBulb.Brightness}`,
        commandType: 'command',
      });
      this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} Sending request to SwitchBot API, body: ${bodyChange},`);
      try {
        const { body, statusCode } = await request(`${Devices}/${this.device.deviceId}/commands`, {
          body: bodyChange,
          method: 'POST',
          headers: this.platform.generateHeaders(),
        });
        this.debugWarnLog(`${this.device.deviceType}: ${this.accessory.displayName} statusCode: ${statusCode}`);
        const deviceStatus: any = await body.json();
        this.debugWarnLog(`${this.device.deviceType}: ${this.accessory.displayName} deviceStatus: ${JSON.stringify(deviceStatus)}`);
        this.debugWarnLog(`${this.device.deviceType}: ${this.accessory.displayName} deviceStatus body: ${JSON.stringify(deviceStatus.body)}`);
        this.debugWarnLog(`${this.device.deviceType}: ${this.accessory.displayName} deviceStatus statusCode: ${deviceStatus.statusCode}`);
        if ((statusCode === 200 || statusCode === 100) && (deviceStatus.statusCode === 200 || deviceStatus.statusCode === 100)) {
          this.debugSuccessLog(`${this.device.deviceType}: ${this.accessory.displayName} `
            + `statusCode: ${statusCode} & deviceStatus StatusCode: ${deviceStatus.statusCode}`);
          this.successLog(`${this.device.deviceType}: ${this.accessory.displayName} `
            + `request to SwitchBot API, body: ${JSON.stringify(JSON.parse(bodyChange))} sent successfully`);
        } else {
          this.statusCode(statusCode);
          this.statusCode(deviceStatus.statusCode);
        }
      } catch (e: any) {
        this.apiError(e);
        this.errorLog(`${this.device.deviceType}: ${this.accessory.displayName} failed pushBrightnessChanges with ${this.device.connectionType}`
          + ` Connection, Error Message: ${JSON.stringify(e.message)}`);
      }
    } else {
      this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} No pushBrightnessChanges.`
        + `Brightness: ${this.LightBulb.Brightness}, `
        + `BrightnessCached: ${this.accessory.context.Brightness}`);
    }
  }

  /**
   * Handle requests to set the value of the "On" characteristic
   */
  async OnSet(value: CharacteristicValue): Promise<void> {
    if (this.LightBulb.On === this.accessory.context.On) {
      this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} No Changes, Set On: ${value}`);
    } else {
      this.infoLog(`${this.device.deviceType}: ${this.accessory.displayName} Set On: ${value}`);
    }

    this.LightBulb.On = value;
    this.doCeilingLightUpdate.next();
  }

  /**
   * Handle requests to set the value of the "Brightness" characteristic
   */
  async BrightnessSet(value: CharacteristicValue): Promise<void> {
    if (this.LightBulb.Brightness === this.accessory.context.Brightness) {
      this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} No Changes, Set Brightness: ${value}`);
    } else if (this.LightBulb.On) {
      this.infoLog(`${this.device.deviceType}: ${this.accessory.displayName} Set Brightness: ${value}`);
    } else {
      this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} Set Brightness: ${value}`);
    }

    this.LightBulb.Brightness = value;
    this.doCeilingLightUpdate.next();
  }

  /**
   * Handle requests to set the value of the "ColorTemperature" characteristic
   */
  async ColorTemperatureSet(value: CharacteristicValue): Promise<void> {
    if (this.LightBulb.ColorTemperature === this.accessory.context.ColorTemperature) {
      this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} No Changes, Set ColorTemperature: ${value}`);
    } else if (this.LightBulb.On) {
      this.infoLog(`${this.device.deviceType}: ${this.accessory.displayName} Set ColorTemperature: ${value}`);
    } else {
      this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} Set ColorTemperature: ${value}`);
    }

    const minKelvin = 2000;
    const maxKelvin = 9000;
    // Convert mired to kelvin to nearest 100 (SwitchBot seems to need this)
    const kelvin = Math.round(1000000 / Number(value) / 100) * 100;

    // Check and increase/decrease kelvin to range of device
    const k = Math.min(Math.max(kelvin, minKelvin), maxKelvin);

    if (!this.accessory.context.On || this.accessory.context.kelvin === k) {
      return;
    }

    // Updating the hue/sat to the corresponding values mimics native adaptive lighting
    const hs = m2hs(value);
    this.LightBulb.Service.updateCharacteristic(this.hap.Characteristic.Hue, hs[0]);
    this.LightBulb.Service.updateCharacteristic(this.hap.Characteristic.Saturation, hs[1]);

    this.LightBulb.ColorTemperature = value;
    this.doCeilingLightUpdate.next();
  }

  /**
   * Handle requests to set the value of the "Hue" characteristic
   */
  async HueSet(value: CharacteristicValue): Promise<void> {
    if (this.LightBulb.Hue === this.accessory.context.Hue) {
      this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} No Changes, Set Hue: ${value}`);
    } else if (this.LightBulb.On) {
      this.infoLog(`${this.device.deviceType}: ${this.accessory.displayName} Set Hue: ${value}`);
    } else {
      this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} Set Hue: ${value}`);
    }

    this.LightBulb.Service.updateCharacteristic(this.hap.Characteristic.ColorTemperature, 140);

    this.LightBulb.Hue = value;
    this.doCeilingLightUpdate.next();
  }

  /**
   * Handle requests to set the value of the "Saturation" characteristic
   */
  async SaturationSet(value: CharacteristicValue): Promise<void> {
    if (this.LightBulb.Saturation === this.accessory.context.Saturation) {
      this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} No Changes, Set Saturation: ${value}`);
    } else if (this.LightBulb.On) {
      this.infoLog(`${this.device.deviceType}: ${this.accessory.displayName} Set Saturation: ${value}`);
    } else {
      this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} Set Saturation: ${value}`);
    }

    this.LightBulb.Service.updateCharacteristic(this.hap.Characteristic.ColorTemperature, 140);

    this.LightBulb.Saturation = value;
    this.doCeilingLightUpdate.next();
  }

  async updateHomeKitCharacteristics(): Promise<void> {
    if (this.LightBulb.On === undefined) {
      this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} On: ${this.LightBulb.On}`);
    } else {
      this.accessory.context.On = this.LightBulb.On;
      this.LightBulb!.Service.updateCharacteristic(this.hap.Characteristic.On, this.LightBulb.On);
      this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} updateCharacteristic On: ${this.LightBulb.On}`);
    }
    if (this.LightBulb.Brightness === undefined) {
      this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} Brightness: ${this.LightBulb.Brightness}`);
    } else {
      this.accessory.context.Brightness = this.LightBulb.Brightness;
      this.LightBulb!.Service.updateCharacteristic(this.hap.Characteristic.Brightness, this.LightBulb.Brightness);
      this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} updateCharacteristic Brightness: ${this.LightBulb.Brightness}`);
    }
    if (this.LightBulb.ColorTemperature === undefined) {
      this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} ColorTemperature: ${this.LightBulb.ColorTemperature}`);
    } else {
      this.accessory.context.ColorTemperature = this.LightBulb.ColorTemperature;
      this.LightBulb!.Service.updateCharacteristic(this.hap.Characteristic.ColorTemperature, this.LightBulb.ColorTemperature);
      this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName}`
        + ` updateCharacteristic ColorTemperature: ${this.LightBulb.ColorTemperature}`);
    }
    if (this.LightBulb.Hue === undefined) {
      this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} Hue: ${this.LightBulb.Hue}`);
    } else {
      this.accessory.context.Hue = this.LightBulb.Hue;
      this.LightBulb!.Service.updateCharacteristic(this.hap.Characteristic.Hue, this.LightBulb.Hue);
      this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} updateCharacteristic Hue: ${this.LightBulb.Hue}`);
    }
    if (this.LightBulb.Saturation === undefined) {
      this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} Saturation: ${this.LightBulb.Saturation}`);
    } else {
      this.accessory.context.Saturation = this.LightBulb.Saturation;
      this.LightBulb!.Service.updateCharacteristic(this.hap.Characteristic.Saturation, this.LightBulb.Saturation);
      this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} updateCharacteristic Saturation: ${this.LightBulb.Saturation}`);
    }
  }

  async adaptiveLighting(device: device & devicesConfig): Promise<void> {
    if (device.ceilinglight?.adaptiveLightingShift) {
      this.adaptiveLightingShift = device.ceilinglight.adaptiveLightingShift;
      this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} adaptiveLightingShift: ${this.adaptiveLightingShift}`);
    } else {
      this.adaptiveLightingShift = 0;
      this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} adaptiveLightingShift: ${this.adaptiveLightingShift}`);
    }
  }

  async BLEPushConnection() {
    if (this.platform.config.credentials?.token && this.device.connectionType === 'BLE/OpenAPI') {
      this.warnLog(`${this.device.deviceType}: ${this.accessory.displayName} Using OpenAPI Connection to Push Changes`);
      await this.openAPIpushChanges();
    }
  }

  async BLERefreshConnection(switchbot: any): Promise<void> {
    this.errorLog(`${this.device.deviceType}: ${this.accessory.displayName} wasn't able to establish BLE Connection, node-switchbot:`
      + ` ${JSON.stringify(switchbot)}`);
    if (this.platform.config.credentials?.token && this.device.connectionType === 'BLE/OpenAPI') {
      this.warnLog(`${this.device.deviceType}: ${this.accessory.displayName} Using OpenAPI Connection to Refresh Status`);
      await this.openAPIRefreshStatus();
    }
  }

  async offlineOff(): Promise<void> {
    if (this.device.offline) {
      this.LightBulb.Service.updateCharacteristic(this.hap.Characteristic.On, false);
    }
  }

  apiError(e: any): void {
    this.LightBulb!.Service.updateCharacteristic(this.hap.Characteristic.On, e);
    this.LightBulb!.Service.updateCharacteristic(this.hap.Characteristic.Hue, e);
    this.LightBulb!.Service.updateCharacteristic(this.hap.Characteristic.Brightness, e);
    this.LightBulb!.Service.updateCharacteristic(this.hap.Characteristic.Saturation, e);
    this.LightBulb!.Service.updateCharacteristic(this.hap.Characteristic.ColorTemperature, e);
  }
}
