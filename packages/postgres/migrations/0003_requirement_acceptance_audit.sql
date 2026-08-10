ALTER TABLE forgex_requirement_audit
  DROP CONSTRAINT IF EXISTS forgex_requirement_audit_action_check;

ALTER TABLE forgex_requirement_audit
  ADD CONSTRAINT forgex_requirement_audit_action_check CHECK (
    action IN (
      'requirement.created',
      'requirement.confirmation_submitted',
      'requirement.confirmed',
      'requirement.accepted',
      'delivery.requested',
      'delivery.dispatched'
    )
  );
