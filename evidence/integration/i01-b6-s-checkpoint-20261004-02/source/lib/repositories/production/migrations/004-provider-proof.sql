CREATE TABLE provider_proof_artifacts (
  hash TEXT PRIMARY KEY CHECK(length(hash)=64 AND hash NOT GLOB '*[^0-9a-f]*'),
  kind TEXT NOT NULL CHECK(kind IN ('account_session','reviewed_policy','media_quote','execution_session')),
  canonical_payload TEXT NOT NULL CHECK(json_valid(canonical_payload) AND length(CAST(canonical_payload AS BLOB))<=262144),
  created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 0 AND 253402300799999),
  CHECK(json_extract(canonical_payload,'$.schemaVersion') IS 1 AND json_extract(canonical_payload,'$.kind') IS kind)
);

CREATE TABLE provider_credential_generations (
  provider_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
  generation_id TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL,
  credential_fingerprint TEXT NOT NULL CHECK(length(credential_fingerprint)=64 AND credential_fingerprint NOT GLOB '*[^0-9a-f]*'),
  changed_at INTEGER NOT NULL CHECK(typeof(changed_at)='integer' AND changed_at BETWEEN 0 AND 253402300799999),
  PRIMARY KEY(provider_id,revision),
  UNIQUE(provider_id,revision,generation_id)
);

CREATE TABLE provider_credential_heads (
  provider_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  generation_id TEXT NOT NULL UNIQUE,
  FOREIGN KEY(provider_id,revision,generation_id) REFERENCES provider_credential_generations(provider_id,revision,generation_id) ON DELETE RESTRICT
);

CREATE TABLE provider_quote_proofs (
  budget_quote_id TEXT PRIMARY KEY REFERENCES budget_quotes(id) ON DELETE RESTRICT,
  media_quote_kind TEXT NOT NULL DEFAULT 'quote' CHECK(media_quote_kind='quote'),
  media_quote_id TEXT NOT NULL UNIQUE,
  artifact_hash TEXT NOT NULL UNIQUE REFERENCES provider_proof_artifacts(hash) ON DELETE RESTRICT,
  FOREIGN KEY(media_quote_kind,media_quote_id) REFERENCES records(kind,id) ON DELETE RESTRICT
);

CREATE TABLE provider_execution_proofs (
  execution_id TEXT PRIMARY KEY REFERENCES budget_executions(execution_id) ON DELETE RESTRICT,
  reservation_id TEXT NOT NULL UNIQUE REFERENCES budget_reservations(id) ON DELETE RESTRICT,
  artifact_hash TEXT NOT NULL UNIQUE REFERENCES provider_proof_artifacts(hash) ON DELETE RESTRICT
);

CREATE TRIGGER provider_proof_artifacts_no_update BEFORE UPDATE ON provider_proof_artifacts BEGIN SELECT RAISE(ABORT,'immutable provider proof'); END;
CREATE TRIGGER provider_proof_artifacts_no_delete BEFORE DELETE ON provider_proof_artifacts BEGIN SELECT RAISE(ABORT,'immutable provider proof'); END;
CREATE TRIGGER provider_credential_generations_no_update BEFORE UPDATE ON provider_credential_generations BEGIN SELECT RAISE(ABORT,'immutable provider proof'); END;
CREATE TRIGGER provider_credential_generations_no_delete BEFORE DELETE ON provider_credential_generations BEGIN SELECT RAISE(ABORT,'immutable provider proof'); END;
CREATE TRIGGER provider_quote_proofs_no_update BEFORE UPDATE ON provider_quote_proofs BEGIN SELECT RAISE(ABORT,'immutable provider proof'); END;
CREATE TRIGGER provider_quote_proofs_no_delete BEFORE DELETE ON provider_quote_proofs BEGIN SELECT RAISE(ABORT,'immutable provider proof'); END;
CREATE TRIGGER provider_execution_proofs_no_update BEFORE UPDATE ON provider_execution_proofs BEGIN SELECT RAISE(ABORT,'immutable provider proof'); END;
CREATE TRIGGER provider_execution_proofs_no_delete BEFORE DELETE ON provider_execution_proofs BEGIN SELECT RAISE(ABORT,'immutable provider proof'); END;

CREATE TRIGGER provider_credential_heads_no_delete BEFORE DELETE ON provider_credential_heads BEGIN SELECT RAISE(ABORT,'immutable provider proof head'); END;
CREATE TRIGGER provider_credential_heads_insert_first BEFORE INSERT ON provider_credential_heads
WHEN NEW.revision<>1 OR NOT EXISTS(SELECT 1 FROM provider_credential_generations g WHERE g.provider_id=NEW.provider_id AND g.revision=NEW.revision AND g.generation_id=NEW.generation_id)
BEGIN SELECT RAISE(ABORT,'invalid provider proof head'); END;
CREATE TRIGGER provider_credential_heads_update_cas BEFORE UPDATE ON provider_credential_heads
WHEN NEW.provider_id<>OLD.provider_id OR NEW.revision<>OLD.revision+1 OR NEW.generation_id=OLD.generation_id OR
  NOT EXISTS(SELECT 1 FROM provider_credential_generations oldg JOIN provider_credential_generations newg ON newg.provider_id=NEW.provider_id AND newg.revision=NEW.revision AND newg.generation_id=NEW.generation_id
    WHERE oldg.provider_id=OLD.provider_id AND oldg.revision=OLD.revision AND oldg.generation_id=OLD.generation_id AND newg.changed_at>=oldg.changed_at AND (newg.account_id<>oldg.account_id OR newg.credential_fingerprint<>oldg.credential_fingerprint))
BEGIN SELECT RAISE(ABORT,'invalid provider proof head'); END;

CREATE TRIGGER provider_quote_proofs_validate BEFORE INSERT ON provider_quote_proofs
WHEN NOT EXISTS(SELECT 1 FROM provider_proof_artifacts a JOIN budget_quotes b ON b.id=NEW.budget_quote_id JOIN budget_quote_bindings qb ON qb.budget_quote_id=b.id
  WHERE a.hash=NEW.artifact_hash AND a.kind='media_quote' AND b.media_quote_id=NEW.media_quote_id)
BEGIN SELECT RAISE(ABORT,'invalid provider quote proof link'); END;
CREATE TRIGGER provider_execution_proofs_validate BEFORE INSERT ON provider_execution_proofs
WHEN NOT EXISTS(SELECT 1 FROM provider_proof_artifacts a JOIN budget_reservations r ON r.execution_id=NEW.execution_id AND r.id=NEW.reservation_id
  WHERE a.hash=NEW.artifact_hash AND a.kind='execution_session')
BEGIN SELECT RAISE(ABORT,'invalid provider execution proof link'); END;
