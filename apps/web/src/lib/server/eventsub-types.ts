export const EVENT_TYPES = ["channel.subscribe", "channel.subscription.message", "channel.subscription.gift"] as const;
export type SubscriptionEventType = (typeof EVENT_TYPES)[number];
export const CHAT_EVENT_TYPE = "channel.chat.message" as const;
export const BITS_EVENT_TYPE = "extension.bits_transaction.create" as const;
export type EventSubType = SubscriptionEventType | typeof CHAT_EVENT_TYPE | typeof BITS_EVENT_TYPE;
export const ACTIVE_INTERRUPT_STATES = ["queued", "planning", "screening", "rendering", "validating", "ready", "scheduled", "playing"] as const;

export interface EventSubSubscription {
  id: string;
  type: EventSubType;
  version: "1";
  status?: string;
  condition: { broadcaster_user_id?: string; user_id?: string; extension_client_id?: string };
  transport?: { method?: string; callback?: string };
}

export interface EventSubEnvelope {
  subscription: EventSubSubscription;
  event?: Record<string, unknown>;
  challenge?: string;
}
