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
      'delivery.completed',
      'verification.preview_recorded',
      'verification.failed',
      'verification.completed'
    )
  );
