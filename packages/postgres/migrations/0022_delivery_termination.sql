ALTER TABLE forgex_delivery_outbox
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;

ALTER TABLE forgex_delivery_outbox
  ADD COLUMN IF NOT EXISTS cancellation_completed_at timestamptz;

ALTER TABLE forgex_delivery_outbox
  DROP CONSTRAINT IF EXISTS forgex_delivery_outbox_cancelled_at_check;

ALTER TABLE forgex_delivery_outbox
  ADD CONSTRAINT forgex_delivery_outbox_cancelled_at_check CHECK (
    cancelled_at IS NULL OR cancelled_at >= requested_at
  );

ALTER TABLE forgex_delivery_outbox
  DROP CONSTRAINT IF EXISTS forgex_delivery_outbox_cancellation_completed_at_check;

ALTER TABLE forgex_delivery_outbox
  ADD CONSTRAINT forgex_delivery_outbox_cancellation_completed_at_check CHECK (
    cancellation_completed_at IS NULL OR (
      cancelled_at IS NOT NULL AND cancellation_completed_at >= cancelled_at
    )
  );

ALTER TABLE forgex_requirement_audit
  DROP CONSTRAINT IF EXISTS forgex_requirement_audit_action_check;

ALTER TABLE forgex_requirement_audit
  ADD CONSTRAINT forgex_requirement_audit_action_check CHECK (
    action IN (
      'requirement.created',
      'requirement.revised',
      'requirement.confirmation_submitted',
      'requirement.confirmed',
      'requirement.accepted',
      'delivery.requested',
      'delivery.dispatched',
      'delivery.terminated',
      'delivery.completed',
      'verification.preview_recorded',
      'verification.failed',
      'verification.completed'
    )
  );
