const MAX_STOPS = 8;
const PRIORITY_WEIGHT = Object.freeze({ low: 0, normal: 1, medium: 2, high: 3 });

function dateValue(value, name) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new TypeError(`${name} must be a valid date-time`);
  return timestamp;
}

function normalizeStops(stops) {
  if (!Array.isArray(stops) || stops.length < 1 || stops.length > MAX_STOPS) {
    throw new TypeError(`stops must contain between 1 and at most ${MAX_STOPS} visits`);
  }
  const ids = new Set();
  return stops.map((stop, index) => {
    if (!stop || typeof stop !== "object" || Array.isArray(stop)) {
      throw new TypeError(`stops[${index}] must be an object`);
    }
    const id = typeof stop.id === "string" ? stop.id.trim() : "";
    if (!id) throw new TypeError(`stops[${index}].id is required`);
    if (ids.has(id)) throw new TypeError("stop ids must be unique");
    ids.add(id);
    const priority = stop.priority ?? "normal";
    if (!Object.hasOwn(PRIORITY_WEIGHT, priority)) {
      throw new TypeError(`stops[${index}].priority is invalid`);
    }
    const visitMinutes = Number(stop.visitMinutes);
    if (!Number.isSafeInteger(visitMinutes) || visitMinutes < 1 || visitMinutes > 480) {
      throw new TypeError(`stops[${index}].visitMinutes must be an integer between 1 and 480`);
    }
    const appointmentAt = stop.appointmentAt === undefined || stop.appointmentAt === null || stop.appointmentAt === ""
      ? null
      : new Date(dateValue(stop.appointmentAt, `stops[${index}].appointmentAt`)).toISOString();
    return { ...stop, id, priority, visitMinutes, appointmentAt };
  });
}

function normalizeMatrix(matrix, size) {
  if (!Array.isArray(matrix) || matrix.length !== size) {
    throw new TypeError(`durationMatrix dimension must be ${size} by ${size}`);
  }
  return matrix.map((row, rowIndex) => {
    if (!Array.isArray(row) || row.length !== size) {
      throw new TypeError(`durationMatrix dimension must be ${size} by ${size}`);
    }
    return row.map((value, columnIndex) => {
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new TypeError(`durationMatrix[${rowIndex}][${columnIndex}] must be a non-negative number`);
      }
      return parsed;
    });
  });
}

function normalizeInput({ departureAt, stops, durationMatrix } = {}) {
  const departureTimestamp = dateValue(departureAt, "departureAt");
  const normalizedStops = normalizeStops(stops);
  const normalizedMatrix = normalizeMatrix(durationMatrix, normalizedStops.length + 1);
  return {
    departureAt: new Date(departureTimestamp).toISOString(),
    departureTimestamp,
    stops: normalizedStops,
    durationMatrix: normalizedMatrix,
  };
}

function assertCompleteOrder(orderedStopIds, stops) {
  if (!Array.isArray(orderedStopIds) || orderedStopIds.length !== stops.length) {
    throw new TypeError("orderedStopIds must be a complete permutation of stop ids");
  }
  const expected = new Set(stops.map((stop) => stop.id));
  const actual = new Set(orderedStopIds);
  if (actual.size !== expected.size || orderedStopIds.some((id) => !expected.has(id))) {
    throw new TypeError("orderedStopIds must be a complete permutation of stop ids");
  }
}

function buildSchedule(normalized, orderedStopIds) {
  assertCompleteOrder(orderedStopIds, normalized.stops);
  const stopById = new Map(normalized.stops.map((stop, index) => [stop.id, { stop, matrixIndex: index + 1 }]));
  let currentTimestamp = normalized.departureTimestamp;
  let previousMatrixIndex = 0;
  let driveSecondsTotal = 0;
  let waitSecondsTotal = 0;
  let lateSecondsTotal = 0;
  let visitMinutesTotal = 0;

  const schedule = orderedStopIds.map((stopId, index) => {
    const { stop, matrixIndex } = stopById.get(stopId);
    const driveSeconds = normalized.durationMatrix[previousMatrixIndex][matrixIndex];
    const arrivalTimestamp = currentTimestamp + driveSeconds * 1000;
    const appointmentTimestamp = stop.appointmentAt ? Date.parse(stop.appointmentAt) : null;
    const waitSeconds = appointmentTimestamp === null ? 0 : Math.max(0, (appointmentTimestamp - arrivalTimestamp) / 1000);
    const lateSeconds = appointmentTimestamp === null ? 0 : Math.max(0, (arrivalTimestamp - appointmentTimestamp) / 1000);
    const serviceStartTimestamp = arrivalTimestamp + waitSeconds * 1000;
    const departureTimestamp = serviceStartTimestamp + stop.visitMinutes * 60_000;

    driveSecondsTotal += driveSeconds;
    waitSecondsTotal += waitSeconds;
    lateSecondsTotal += lateSeconds;
    visitMinutesTotal += stop.visitMinutes;
    currentTimestamp = departureTimestamp;
    previousMatrixIndex = matrixIndex;

    return {
      stopId,
      sequence: index + 1,
      driveSeconds,
      arrivalAt: new Date(arrivalTimestamp).toISOString(),
      serviceStartAt: new Date(serviceStartTimestamp).toISOString(),
      departureAt: new Date(departureTimestamp).toISOString(),
      waitMinutes: Math.round(waitSeconds / 60),
      lateMinutes: Math.round(lateSeconds / 60),
    };
  });

  return {
    orderedStopIds: [...orderedStopIds],
    schedule,
    totals: {
      driveSeconds: driveSecondsTotal,
      visitMinutes: visitMinutesTotal,
      waitMinutes: Math.round(waitSecondsTotal / 60),
      lateMinutes: Math.round(lateSecondsTotal / 60),
      endAt: new Date(currentTimestamp).toISOString(),
    },
    score: {
      lateSeconds: lateSecondsTotal,
      waitSeconds: waitSecondsTotal,
      priorityPenalty: orderedStopIds.reduce((sum, stopId, position) => (
        sum + PRIORITY_WEIGHT[stopById.get(stopId).stop.priority] * position
      ), 0),
    },
  };
}

function comparePlans(left, right, inputOrder) {
  const leftScore = [left.score.lateSeconds, left.score.priorityPenalty, left.totals.driveSeconds, left.score.waitSeconds];
  const rightScore = [right.score.lateSeconds, right.score.priorityPenalty, right.totals.driveSeconds, right.score.waitSeconds];
  for (let index = 0; index < leftScore.length; index += 1) {
    if (leftScore[index] !== rightScore[index]) return leftScore[index] - rightScore[index];
  }
  for (let index = 0; index < left.orderedStopIds.length; index += 1) {
    const difference = inputOrder.get(left.orderedStopIds[index]) - inputOrder.get(right.orderedStopIds[index]);
    if (difference !== 0) return difference;
  }
  return 0;
}

function forEachPermutation(values, visit, prefix = [], remaining = values) {
  if (remaining.length === 0) {
    visit(prefix);
    return;
  }
  for (let index = 0; index < remaining.length; index += 1) {
    forEachPermutation(
      values,
      visit,
      [...prefix, remaining[index]],
      [...remaining.slice(0, index), ...remaining.slice(index + 1)],
    );
  }
}

function publicPlan(plan) {
  return {
    orderedStopIds: plan.orderedStopIds,
    schedule: plan.schedule,
    totals: plan.totals,
  };
}

export function buildVisitSchedule(input) {
  const normalized = normalizeInput(input);
  return publicPlan(buildSchedule(normalized, input.orderedStopIds));
}

export function optimizeVisitOrder(input) {
  const normalized = normalizeInput(input);
  const ids = normalized.stops.map((stop) => stop.id);
  const inputOrder = new Map(ids.map((id, index) => [id, index]));
  let best = null;
  forEachPermutation(ids, (orderedStopIds) => {
    const candidate = buildSchedule(normalized, orderedStopIds);
    if (!best || comparePlans(candidate, best, inputOrder) < 0) best = candidate;
  });
  return publicPlan(best);
}
