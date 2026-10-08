CREATE TABLE approvals_v3 (
  approval_kind TEXT NOT NULL DEFAULT 'approval' CHECK(approval_kind='approval'),
  approval_id TEXT PRIMARY KEY,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  target_record_kind TEXT NOT NULL,
  target_record_id TEXT NOT NULL,
  target_hash TEXT NOT NULL,
  decision TEXT NOT NULL,
  FOREIGN KEY(approval_kind,approval_id) REFERENCES records(kind,id),
  FOREIGN KEY(target_record_kind,target_record_id) REFERENCES records(kind,id)
);
INSERT INTO approvals_v3(approval_kind,approval_id,target_kind,target_id,target_record_kind,target_record_id,target_hash,decision)
  SELECT approval_kind,approval_id,target_kind,target_id,target_record_kind,target_record_id,target_hash,decision FROM approvals;
DROP TABLE approvals;
ALTER TABLE approvals_v3 RENAME TO approvals;
