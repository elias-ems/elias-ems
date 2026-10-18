import type { Input } from "./types.ts";
export function validate(input: Input) {
  const m = input.model;
  const finite = (x: number) => Number.isFinite(x);
  if (
    ![
      m.capacityKwh,
      m.minSoc,
      m.maxSoc,
      m.soc,
      m.minW,
      m.maxW,
      m.stepW,
      m.dischargeW,
      m.efficiency,
      m.wearPerKwh,
    ].every(finite) ||
    !Object.values(m).every(finite) ||
    m.capacityKwh <= 0 ||
    m.minSoc < 0 ||
    m.maxSoc > 100 ||
    m.minSoc >= m.maxSoc ||
    m.soc < m.minSoc ||
    m.soc > m.maxSoc ||
    m.minW < 0 ||
    m.maxW < m.minW ||
    m.stepW <= 0 ||
    m.dischargeW <= 0 ||
    m.efficiency <= 0 ||
    m.efficiency > 1 ||
    m.wearPerKwh < 0
  )
    throw new Error(
      "Unsupported battery model: initial SoC must be inside configured bounds",
    );
  if (
    m.dischargeStepW !== undefined &&
    (m.dischargeStepW <= 0 ||
      (m.dischargeMinW ?? 0) < 0 ||
      (m.dischargeMinW ?? 0) > m.dischargeW)
  )
    throw new Error("Invalid discharge range");
  const caps = input.capabilities;
  if (
    !caps.modes.length ||
    new Set(caps.modes).size !== caps.modes.length ||
    caps.modes.some(
      (x) => !["balance", "hold", "charge", "discharge"].includes(x),
    ) ||
    typeof caps.gridCharging !== "boolean" ||
    typeof caps.batteryExport !== "boolean"
  )
    throw new Error("Explicit capabilities and permissions required");
  if (
    caps.modes.some((x) => x !== "balance") &&
    (caps.setpointStepW === undefined ||
      !finite(caps.setpointStepW) ||
      caps.setpointStepW <= 0)
  )
    throw new Error("Direct modes require an explicit setpoint step");
  if (
    !finite(input.solarHaircut) ||
    input.solarHaircut < 0 ||
    input.solarHaircut >= 1 ||
    !finite(input.timeLimitSeconds) ||
    input.timeLimitSeconds <= 0 ||
    input.timeLimitSeconds > 120
  )
    throw new Error("Invalid solar scenario or solve budget");
  if (!input.slots.length || input.slots.length > 384)
    throw new Error("Expected 1–384 intervals");
  input.slots.forEach((s, i) => {
    if (
      ![s.start, s.end, s.solarW, s.loadW, s.buy, s.sell].every(finite) ||
      s.end <= s.start ||
      s.solarW < 0 ||
      s.loadW < 0 ||
      (i && input.slots[i - 1].end !== s.start)
    )
      throw new Error("Invalid forecast intervals");
    const p = s.curtailment;
    if (!p) return;
    if (
      ![
        p.fixedW,
        p.availableW,
        p.floorW,
        p.exportAllowanceW,
        p.ceilingW ?? 0,
        p.deadbandW ?? 0,
      ].every((v) => finite(v) && v >= 0) ||
      !finite(p.gridTargetW)
    )
      throw new Error("Invalid PV model");
    for (const a of p.fixedArrays ?? []) {
      if (
        !finite(a.availableW) ||
        !finite(a.ceilingW) ||
        (a.initiallyStepped !== undefined &&
          typeof a.initiallyStepped !== "boolean")
      )
        throw new Error("Invalid fixed PV array");
    }
    for (const a of p.modulatingArrays ?? []) {
      if (!finite(a.availableW) || !finite(a.floorW))
        throw new Error("Invalid modulating PV array");
    }
    for (const a of [...(p.fixedArrays ?? []), ...(p.modulatingArrays ?? [])])
      if (
        Object.values(a).some(
          (v) => typeof v === "number" && (!finite(v) || v < 0),
        )
      )
        throw new Error("Invalid PV array");
    const available =
      p.fixedArrays?.reduce((n, a) => n + a.availableW, 0) ?? p.fixedW;
    const modulating =
      p.modulatingArrays?.reduce((n, a) => n + a.availableW, 0) ?? p.availableW;
    if (
      Math.abs(modulating - p.availableW) > 0.01 ||
      Math.abs(available + modulating - s.solarW) > 0.01
    )
      throw new Error("PV availability must conserve the forecast solar total");
  });
}

/** Reject commands that could not be sent to the declared device. */
export function validateCommands(
  input: Input,
  commands: import("./types.ts").Command[],
) {
  if (commands.length !== input.slots.length)
    throw new Error("Schedule length mismatch");
  const m = input.model;
  const supported = (value: number, min: number, max: number, step?: number) =>
    Number.isFinite(value) &&
    value >= min - 1e-7 &&
    value <= max + 1e-7 &&
    (step === undefined
      ? Math.abs(value - max) < 1e-7
      : Math.abs((value - min) / step - Math.round((value - min) / step)) <
        1e-6);
  commands.forEach((u, i) => {
    if (
      u.start !== input.slots[i].start ||
      u.end !== input.slots[i].end ||
      !input.capabilities.modes.includes(u.mode) ||
      !supported(u.chargeLimitW, m.minW, m.maxW, m.stepW) ||
      !supported(
        u.dischargeLimitW,
        m.dischargeMinW ?? 0,
        m.dischargeW,
        m.dischargeStepW,
      )
    )
      throw new Error("Unsupported interval mode or boundaries");
    if (
      u.mode === "balance"
        ? u.setpointW !== undefined
        : u.mode === "hold"
          ? u.setpointW !== 0
          : u.setpointW === undefined ||
            !Number.isFinite(u.setpointW) ||
            (u.mode === "charge"
              ? u.setpointW <= 0 || u.setpointW > u.chargeLimitW
              : u.setpointW >= 0 || -u.setpointW > u.dischargeLimitW) ||
            !supported(
              Math.abs(u.setpointW),
              0,
              Math.max(m.maxW, m.dischargeW),
              input.capabilities.setpointStepW,
            )
    )
      throw new Error("Invalid mode setpoint");
  });
}
