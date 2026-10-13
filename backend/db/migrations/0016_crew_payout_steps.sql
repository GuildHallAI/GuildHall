ALTER TABLE commission_escrow_operations
  ADD COLUMN parent_operation_id UUID REFERENCES commission_escrow_operations(id) ON DELETE RESTRICT,
  ADD COLUMN operation_index SMALLINT,
  ADD CONSTRAINT commission_escrow_operation_parent_check
    CHECK ((parent_operation_id IS NULL AND operation_index IS NULL)
        OR (parent_operation_id IS NOT NULL AND operation_index IS NOT NULL AND operation_index > 0)),
  ADD CONSTRAINT commission_escrow_operation_child_idx_unique
    UNIQUE (parent_operation_id, operation_index);

CREATE INDEX commission_escrow_children_pending_idx
  ON commission_escrow_operations (parent_operation_id, operation_index)
  WHERE parent_operation_id IS NOT NULL AND state IN ('pending', 'submitted', 'failed');
