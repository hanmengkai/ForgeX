ALTER TABLE forgex_delivery_outbox
  ADD COLUMN IF NOT EXISTS skills jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE forgex_delivery_outbox
  DROP CONSTRAINT IF EXISTS forgex_delivery_outbox_skills_check;

ALTER TABLE forgex_delivery_outbox
  ADD CONSTRAINT forgex_delivery_outbox_skills_check CHECK (
    jsonb_typeof(skills) = 'array'
    AND jsonb_array_length(skills) <= 10
  );
