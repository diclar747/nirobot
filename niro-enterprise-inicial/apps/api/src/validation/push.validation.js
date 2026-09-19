const { z } = require('zod');

const pushKeysSchema = z.object({
  p256dh: z.string().min(1),
  auth: z.string().min(1)
});

const pushSubscriptionSchema = z.object({
  endpoint: z.string().url(),
  keys: pushKeysSchema
});

const subscribeSchema = z.object({
  subscription: pushSubscriptionSchema
});

const unsubscribeSchema = z.object({
  endpoint: z.string().url()
});

module.exports = { subscribeSchema, unsubscribeSchema };
