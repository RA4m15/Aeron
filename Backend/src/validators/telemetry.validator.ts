import { z } from 'zod';

const finiteNumber = (min?: number, max?: number) => {
  let schema = z.number();
  if (min !== undefined) {
    schema = schema.min(min, { message: `Value must be >= ${min}` });
  }
  if (max !== undefined) {
    schema = schema.max(max, { message: `Value must be <= ${max}` });
  }
  return schema.refine((n) => Number.isFinite(n), {
    message: 'Value must be a finite number (no NaN or Infinity)'
  });
};

export const SingleTelemetrySchema = z
  .object({
    droneId: z
      .string({ required_error: 'droneId is required' })
      .trim()
      .min(1, { message: 'droneId cannot be empty' })
      .toUpperCase(),
    flightSessionId: z.string().trim().optional().nullable(),
    recordedAt: z
      .string()
      .or(z.number())
      .transform((val) => new Date(val))
      .refine((d) => !isNaN(d.getTime()), { message: 'recordedAt must be a valid date/timestamp' }),
    source: z.enum(['REAL', 'SIMULATION'], {
      required_error: 'source must be either "REAL" or "SIMULATION"'
    }),
    isSimulated: z.boolean({ required_error: 'isSimulated boolean is required' }),
    latitude: finiteNumber(-90, 90).optional().nullable(),
    longitude: finiteNumber(-180, 180).optional().nullable(),
    altitude: finiteNumber().optional().nullable(),
    relativeAltitude: finiteNumber().optional().nullable(),
    groundSpeed: finiteNumber(0).optional().nullable(),
    heading: finiteNumber(0, 360).optional().nullable(),
    roll: finiteNumber(-180, 180).optional().nullable(),
    pitch: finiteNumber(-90, 90).optional().nullable(),
    yaw: finiteNumber(0, 360).optional().nullable(),
    climbRate: finiteNumber().optional().nullable(),
    gpsFixType: z.string().trim().optional().nullable(),
    satellites: z.number().int().min(0).optional().nullable(),
    hdop: finiteNumber(0).optional().nullable(),
    batteryVoltage: finiteNumber(0).optional().nullable(),
    batteryCurrent: finiteNumber().optional().nullable(),
    batteryRemainingRaw: finiteNumber(-1, 100).optional().nullable(),
    batteryPercentage: finiteNumber(0, 100).optional().nullable(),
    batteryPercentageSource: z.enum(['FC_ESTIMATE', 'VOLTAGE_ESTIMATE', 'UNKNOWN']).optional().default('UNKNOWN'),
    batteryCellCount: z.number().int().min(1).max(12).optional().default(3),
    batteryCellVoltage: finiteNumber(0).optional().nullable(),
    batteryRemainingMah: finiteNumber(0).optional().nullable(),
    batteryDataValid: z.boolean().optional().default(false),
    flightMode: z.string().trim().optional().nullable(),
    armed: z.boolean().default(false),
    sensorHealth: z.record(z.unknown()).optional().default({}),
    connectionStatus: z.string().trim().optional().default('CONNECTED'),
    attitudeUpdatedAt: z.string().optional().nullable(),
    positionUpdatedAt: z.string().optional().nullable(),
    gpsTimestamp: z.string().or(z.number()).optional().nullable(),
    transport: z.record(z.unknown()).optional().nullable()
  })
  .refine(
    (data) => {
      // Prevent simulation from masquerading as real hardware
      if (data.source === 'REAL' && data.isSimulated === true) {
        return false;
      }
      if (data.source === 'SIMULATION' && data.isSimulated === false) {
        return false;
      }
      return true;
    },
    {
      message: 'Source and isSimulated inconsistency: REAL must have isSimulated=false, SIMULATION must have isSimulated=true',
      path: ['isSimulated']
    }
  );

export const TelemetryIngestSchema = z.union([
  SingleTelemetrySchema,
  z.array(SingleTelemetrySchema).min(1).max(50)
]);

export type SingleTelemetryInput = z.infer<typeof SingleTelemetrySchema>;
export type TelemetryIngestInput = z.infer<typeof TelemetryIngestSchema>;
