/* Copyright(C) 2021-2024, donavanbecker (https://github.com/donavanbecker). All rights reserved.
 *
 * waterdetector.ts: @switchbot/homebridge-switchbot.
 */
import { deviceBase } from './device.js';
import { interval, Subject } from 'rxjs';
import { Devices } from '../settings.js';
import { skipWhile } from 'rxjs/operators';

import type { SwitchBotPlatform } from '../platform.js';
import type { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import type { device, devicesConfig, serviceData, deviceStatus } from '../settings.js';

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class WaterDetector extends deviceBase {
  // Services
  private Battery: {
    Name: CharacteristicValue
    Service: Service;
    BatteryLevel: CharacteristicValue;
    StatusLowBattery: CharacteristicValue;
    ChargingState: CharacteristicValue;
  };

  private LeakSensor?: {
    Name: CharacteristicValue;
    Service: Service;
    StatusActive: CharacteristicValue;
    LeakDetected: CharacteristicValue;
  };

  // Updates
  WaterDetectorUpdateInProgress!: boolean;
  doWaterDetectorUpdate: Subject<void>;

  constructor(
    readonly platform: SwitchBotPlatform,
    accessory: PlatformAccessory,
    device: device & devicesConfig,
  ) {
    super(platform, accessory, device);

    // this is subject we use to track when we need to POST changes to the SwitchBot API
    this.doWaterDetectorUpdate = new Subject();
    this.WaterDetectorUpdateInProgress = false;

    // Initialize Battery Service
    accessory.context.Battery = accessory.context.Battery ?? {};
    this.Battery = {
      Name: accessory.context.Battery.Name ?? `${accessory.displayName} Battery`,
      Service: accessory.getService(this.hap.Service.Battery) ?? accessory.addService(this.hap.Service.Battery) as Service,
      BatteryLevel: accessory.context.BatteryLevel ?? 100,
      StatusLowBattery: accessory.context.StatusLowBattery ?? this.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
      ChargingState: accessory.context.ChargingState ?? this.hap.Characteristic.ChargingState.NOT_CHARGEABLE,
    };
    accessory.context.Battery = this.Battery as object;

    // Initialize Battery Characteristic
    this.Battery.Service
      .setCharacteristic(this.hap.Characteristic.Name, this.Battery.Name)
      .setCharacteristic(this.hap.Characteristic.ChargingState, this.hap.Characteristic.ChargingState.NOT_CHARGEABLE)
      .getCharacteristic(this.hap.Characteristic.BatteryLevel)
      .onGet(() => {
        return this.Battery.StatusLowBattery;
      });

    this.Battery.Service
      .getCharacteristic(this.hap.Characteristic.StatusLowBattery)
      .onGet(() => {
        return this.Battery.StatusLowBattery;
      });

    // Initialize Leak Sensor Service
    if (device.waterdetector?.hide_leak) {
      if (this.LeakSensor) {
        this.debugLog(`${this.device.deviceType}: ${accessory.displayName} Removing Leak Sensor Service`);
        this.LeakSensor.Service = this.accessory.getService(this.hap.Service.LeakSensor) as Service;
        accessory.removeService(this.LeakSensor.Service);
      } else {
        this.debugLog(`${this.device.deviceType}: ${accessory.displayName} Leak Sensor Service Not Found`);
      }
    } else {
      accessory.context.LeakSensor = accessory.context.LeakSensor ?? {};
      this.LeakSensor = {
        Name: accessory.context.LeakSensor.Name ?? `${accessory.displayName} Leak Sensor`,
        Service: accessory.getService(this.hap.Service.LeakSensor) ?? this.accessory.addService(this.hap.Service.LeakSensor) as Service,
        StatusActive: accessory.context.StatusActive ?? false,
        LeakDetected: accessory.context.LeakDetected ?? this.hap.Characteristic.LeakDetected.LEAK_NOT_DETECTED,
      };
      accessory.context.LeakSensor = this.LeakSensor as object;

      // Initialize LeakSensor Characteristic
      this.LeakSensor!.Service
        .setCharacteristic(this.hap.Characteristic.Name, this.LeakSensor.Name)
        .setCharacteristic(this.hap.Characteristic.StatusActive, true)
        .getCharacteristic(this.hap.Characteristic.LeakDetected)
        .onGet(() => {
          return this.LeakSensor!.LeakDetected;
        });
    }

    // Retrieve initial values and updateHomekit
    this.refreshStatus();

    // Retrieve initial values and updateHomekit
    this.updateHomeKitCharacteristics();

    // Start an update interval
    interval(this.deviceRefreshRate * 1000)
      .pipe(skipWhile(() => this.WaterDetectorUpdateInProgress))
      .subscribe(async () => {
        await this.refreshStatus();
      });

    //regisiter webhook event handler
    this.registerWebhook(accessory, device);
  }

  async BLEparseStatus(serviceData: serviceData): Promise<void> {
    this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} BLEparseStatus`);
    // Battery
    this.Battery.BatteryLevel = Number(serviceData.battery);
    if (this.Battery.BatteryLevel < 15) {
      this.Battery.StatusLowBattery = this.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW;
    } else {
      this.Battery.StatusLowBattery = this.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
    }
    this.debugLog(`${this.accessory.displayName} BatteryLevel: ${this.Battery.BatteryLevel}, StatusLowBattery: ${this.Battery.StatusLowBattery}`);

    // LeakDetected
    if (this.device.waterdetector?.hide_leak) {
      this.LeakSensor!.LeakDetected = serviceData.status!;
      this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} LeakDetected: ${this.LeakSensor!.LeakDetected}`);
    }
  }

  async openAPIparseStatus(deviceStatus: deviceStatus): Promise<void> {
    this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} openAPIparseStatus`);
    // StatusLowBattery
    this.Battery.BatteryLevel = Number(deviceStatus.body.battery);
    if (this.Battery.BatteryLevel < 10) {
      this.Battery.StatusLowBattery = this.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW;
    } else {
      this.Battery.StatusLowBattery = this.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
    }
    this.debugLog(`${this.accessory.displayName} BatteryLevel: ${this.Battery.BatteryLevel}, StatusLowBattery: ${this.Battery.StatusLowBattery}`);

    // BatteryLevel
    if (Number.isNaN(this.Battery.BatteryLevel)) {
      this.Battery.BatteryLevel = 100;
    }
    this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} BatteryLevel: ${this.Battery.BatteryLevel}`);

    // LeakDetected
    if (!this.device.waterdetector?.hide_leak) {
      this.LeakSensor!.LeakDetected = deviceStatus.body.status!;
      this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} LeakDetected: ${this.LeakSensor!.LeakDetected}`);
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

  async refreshStatus(): Promise<void> {
    if (!this.device.enableCloudService && this.OpenAPI) {
      this.errorLog(`${this.device.deviceType}: ${this.accessory.displayName} refreshStatus enableCloudService: ${this.device.enableCloudService}`);
    } else if (this.BLE) {
      await this.BLERefreshStatus();
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
          const { detectionState, battery } = context;
          const { LeakDetected } = this.LeakSensor ? this.LeakSensor : { LeakDetected: undefined };
          const { BatteryLevel } = this.Battery ? this.Battery : { BatteryLevel: undefined };
          this.debugLog(`${device.deviceType}: ${accessory.displayName} (detectionState, battery) = Webhook: (${detectionState}, ${battery}), `
            + `current: (${LeakDetected}, ${BatteryLevel})`);
          if (!device.waterdetector?.hide_leak) {
            this.LeakSensor!.LeakDetected = detectionState;
          }
          this.Battery.BatteryLevel = battery;
          this.updateHomeKitCharacteristics();
        } catch (e: any) {
          this.errorLog(`${device.deviceType}: ${accessory.displayName} failed to handle webhook. Received: ${JSON.stringify(context)} Error: ${e}`);
        }
      };
    } else {
      this.debugLog(`${device.deviceType}: ${accessory.displayName} is not listening webhook.`);
    }
  }

  /**
   * Updates the status for each of the HomeKit Characteristics
   */
  async updateHomeKitCharacteristics(): Promise<void> {
    const mqttmessage: string[] = [];
    const entry = { time: Math.round(new Date().valueOf() / 1000) };
    if (!this.device.waterdetector?.hide_leak) {
      if (this.LeakSensor!.LeakDetected === undefined) {
        this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} LeakDetected: ${this.LeakSensor!.LeakDetected}`);
      } else {
        if (this.device.mqttURL) {
          mqttmessage.push(`"LeakDetected": ${this.LeakSensor!.LeakDetected}`);
        }
        if (this.device.history) {
          entry['leak'] = this.LeakSensor!.LeakDetected;
        }
        this.accessory.context.LeakDetected = this.LeakSensor!.LeakDetected;
        this.LeakSensor!.Service.updateCharacteristic(this.hap.Characteristic.LeakDetected, this.LeakSensor!.LeakDetected);
        this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} updateCharacteristic LeakDetected: ${this.LeakSensor!.LeakDetected}`);
      }
    }
    if (this.Battery.BatteryLevel === undefined) {
      this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} BatteryLevel: ${this.Battery.BatteryLevel}`);
    } else {
      if (this.device.mqttURL) {
        mqttmessage.push(`"battery": ${this.Battery.BatteryLevel}`);
      }
      this.accessory.context.BatteryLevel = this.Battery.BatteryLevel;
      this.Battery.Service.updateCharacteristic(this.hap.Characteristic.BatteryLevel, this.Battery.BatteryLevel);
      this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} updateCharacteristic BatteryLevel: ${this.Battery.BatteryLevel}`);
    }
    if (this.Battery.StatusLowBattery === undefined) {
      this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} StatusLowBattery: ${this.Battery.StatusLowBattery}`);
    } else {
      if (this.device.mqttURL) {
        mqttmessage.push(`"lowBattery": ${this.Battery.StatusLowBattery}`);
      }
      this.accessory.context.StatusLowBattery = this.Battery.StatusLowBattery;
      this.Battery.Service.updateCharacteristic(this.hap.Characteristic.StatusLowBattery, this.Battery.StatusLowBattery);
      this.debugLog(`${this.device.deviceType}: ${this.accessory.displayName} updateCharacteristic`
        + ` StatusLowBattery: ${this.Battery.StatusLowBattery}`);
    }
    if (this.device.mqttURL) {
      this.mqttPublish(`{${mqttmessage.join(',')}}`);
    }
    if (!this.device.waterdetector?.hide_leak) {
      if (Number(this.LeakSensor!.LeakDetected) > 0) {
        // reject unreliable data
        if (this.device.history) {
          this.historyService?.addEntry(entry);
        }
      }
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
    if (this.device.offline && !this.device.waterdetector?.hide_leak) {
      this.LeakSensor!.Service.updateCharacteristic(this.hap.Characteristic.LeakDetected, this.hap.Characteristic.LeakDetected.LEAK_NOT_DETECTED);
    }
  }

  async apiError(e: any): Promise<void> {
    if (!this.device.waterdetector?.hide_leak) {
      this.LeakSensor!.Service.updateCharacteristic(this.hap.Characteristic.LeakDetected, e);
    }
    this.Battery.Service.updateCharacteristic(this.hap.Characteristic.BatteryLevel, e);
    this.Battery.Service.updateCharacteristic(this.hap.Characteristic.StatusLowBattery, e);
  }
}
