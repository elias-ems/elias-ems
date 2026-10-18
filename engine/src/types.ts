export type ChargeInterval = {
  start: number;
  end: number;
  solarW: number;
  loadW: number;
  buy: number;
  sell: number;
  estimatedPrice: boolean;
  /** PV curtailment projected at controller equilibrium for this interval. */
  curtailment?: {
    /** Generation which this controller cannot change. */
    fixedW: number;
    fixedArrays?: {
      availableW: number;
      ceilingW: number;
      stepW?: number;
      initiallyStepped?: boolean;
    }[];
    deadbandW?: number;
    modulatingArrays?: {
      availableW: number;
      floorW: number;
      ceilingW?: number;
    }[];
    /** Forecast generation available from the modulating arrays. */
    availableW: number;
    /** Lowest combined output the modulating arrays may be commanded to. */
    floorW: number;
    /** Optional direct cap (the soft-ceiling strategy). */
    ceilingW?: number;
    /** Signed meter target: positive importing, negative exporting. */
    gridTargetW: number;
    /** Export deliberately allowed by the graded-export strategy. */
    exportAllowanceW: number;
  };
};
export type ChargeModel = {
  capacityKwh: number;
  minSoc: number;
  maxSoc: number;
  soc: number;
  minW: number;
  maxW: number;
  stepW: number;
  dischargeW: number;
  /** Optional controllable AC output range; absent means native discharge. */
  dischargeMinW?: number;
  dischargeStepW?: number;
  efficiency: number;
  wearPerKwh: number;
};

export type Mode = "balance" | "hold" | "charge" | "discharge";
export type Command = {
  start: number;
  end: number;
  chargeLimitW: number;
  dischargeLimitW: number;
} & (
  | { mode: "balance"; setpointW?: never }
  | { mode: "hold"; setpointW: 0 }
  | { mode: "charge" | "discharge"; setpointW: number }
);
export type Input = {
  model: ChargeModel;
  slots: ChargeInterval[];
  solarHaircut: number;
  capabilities: {
    modes: Mode[];
    gridCharging: boolean;
    batteryExport: boolean;
    /** Required explicitly when any direct mode is available. */
    setpointStepW?: number;
  };
  timeLimitSeconds: number;
};
/** Contract only: no publisher or live execution is installed. */
export type BatteryControlEvent = {
  schemaVersion: 1;
  batteryId: string;
  commandId: string;
  ownerEpoch: string;
  issuedAt: number;
} & (
  | {
      action: "apply";
      command: Command;
      permissions: { gridCharging: boolean; batteryExport: boolean };
    }
  | {
      action: "release";
      reason: "disabled" | "expired" | "restart" | "failure";
    }
);
