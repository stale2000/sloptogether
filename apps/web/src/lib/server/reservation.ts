export type ReservationSetting =
  | "SLOPTOGETHER_GENERATION_ATTEMPT_RESERVATION_USD"
  | "SLOPTOGETHER_SUBSCRIBER_ATTEMPT_RESERVATION_USD";

export function reservationUsd(name:ReservationSetting):number|null{
  const value=Number(process.env[name]);
  return Number.isFinite(value)&&value>=0.0001&&value<=500?Math.ceil(value*10_000)/10_000:null;
}
