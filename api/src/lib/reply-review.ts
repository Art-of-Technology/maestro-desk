import { z } from 'zod';
import { ReplySource } from './customer-reply.js';

export const ReplyReview = z.object({
  references: z.array(ReplySource.extend({
    url: z.string().max(1500).url().refine(value => {
      try {
        const url = new URL(value);
        return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
      } catch { return false; }
    }).optional(),
  })).max(20),
  notes: z.array(z.string().max(2000)).max(10),
}).strict();
