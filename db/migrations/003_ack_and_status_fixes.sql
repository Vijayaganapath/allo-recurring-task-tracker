-- Migration 003: Acknowledgement and escalation status fixes

ALTER TABLE escalation_events
  ADD COLUMN status ENUM('PENDING','SENT','FAILED') NOT NULL DEFAULT 'PENDING' AFTER sent_to,
  ADD COLUMN error_message VARCHAR(500) NULL,
  MODIFY sent_at DATETIME NULL;

ALTER TABLE acknowledgements
  ADD COLUMN level TINYINT NOT NULL DEFAULT 1 AFTER manager_id,
  ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN expires_at DATETIME NULL,
  MODIFY acknowledged_at DATETIME NULL,
  DROP INDEX uq_cycle_manager,
  ADD UNIQUE KEY uq_cycle_user_level (cycle_id, manager_id, level);

ALTER TABLE notification_log ADD INDEX idx_notif_created (created_at);
ALTER TABLE audit_log ADD INDEX idx_audit_entity (entity, entity_id);
