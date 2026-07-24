import { randomUUID } from "node:crypto";
import { createOpaqueToken, hashOpaqueToken } from "./crypto.js";
import { AuthError } from "./errors.js";
import type { AuthRepository } from "./repository.js";
import type { DeviceRecord } from "./types.js";

export interface IssuedDevice {
  token: string;
  device: DeviceRecord;
}

export class DeviceService {
  constructor(
    private readonly repository: AuthRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async issue(userId?: string): Promise<IssuedDevice> {
    const token = createOpaqueToken();
    const now = this.now();
    const device: DeviceRecord = {
      id: randomUUID(),
      tokenHash: hashOpaqueToken(token),
      firstSeenAt: now,
      lastSeenAt: now,
      trusted: false,
      riskScore: 0,
      userIds: userId ? [userId] : [],
    };
    await this.repository.saveDevice(device);
    return { token, device };
  }

  async recognize(token: string, userId?: string): Promise<DeviceRecord> {
    const device = await this.repository.findDeviceByHash(
      hashOpaqueToken(token),
    );
    if (!device) {
      throw new AuthError("DEVICE_INVALID", "设备标识无效。");
    }
    device.lastSeenAt = this.now();
    if (userId && !device.userIds.includes(userId)) {
      device.userIds.push(userId);
    }
    await this.repository.updateDevice(device);
    return device;
  }

  async setTrusted(
    token: string,
    trusted: boolean,
  ): Promise<DeviceRecord> {
    const device = await this.requireDevice(token);
    device.trusted = trusted;
    await this.repository.updateDevice(device);
    return device;
  }

  async setRiskScore(
    token: string,
    riskScore: number,
  ): Promise<DeviceRecord> {
    if (!Number.isFinite(riskScore) || riskScore < 0) {
      throw new AuthError("DEVICE_INVALID", "设备风险分必须是非负数。");
    }
    const device = await this.requireDevice(token);
    device.riskScore = riskScore;
    await this.repository.updateDevice(device);
    return device;
  }

  private async requireDevice(token: string): Promise<DeviceRecord> {
    const device = await this.repository.findDeviceByHash(
      hashOpaqueToken(token),
    );
    if (!device) {
      throw new AuthError("DEVICE_INVALID", "设备标识无效。");
    }
    return device;
  }
}
