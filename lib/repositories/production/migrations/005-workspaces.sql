CREATE TABLE workspaces(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 0 AND 9007199254740991),
  updated_at INTEGER NOT NULL CHECK(typeof(updated_at)='integer' AND updated_at BETWEEN 0 AND 9007199254740991),
  save_version INTEGER NOT NULL CHECK(typeof(save_version)='integer' AND save_version>0),
  payload TEXT NOT NULL CHECK(json_valid(payload))
);
CREATE INDEX workspaces_updated_lookup ON workspaces(updated_at DESC,id);

CREATE TABLE production_snapshots(
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 0 AND 9007199254740991),
  payload TEXT NOT NULL CHECK(json_valid(payload))
);
CREATE INDEX production_snapshots_project_lookup ON production_snapshots(project_id,created_at,id);

CREATE TABLE scenes(
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  story_revision_kind TEXT CHECK(story_revision_kind IS NULL OR story_revision_kind='story'),
  story_revision_id TEXT,
  story_order INTEGER NOT NULL CHECK(typeof(story_order)='integer' AND story_order>=0),
  content_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 0 AND 9007199254740991),
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  CHECK((story_revision_id IS NULL)=(story_revision_kind IS NULL)),
  FOREIGN KEY(story_revision_kind,story_revision_id) REFERENCES records(kind,id)
);
CREATE INDEX scenes_project_story_lookup ON scenes(project_id,story_revision_id,story_order,id);

ALTER TABLE jobs ADD COLUMN workspace_id TEXT;
ALTER TABLE jobs ADD COLUMN scene_id TEXT;
ALTER TABLE jobs ADD COLUMN retry_of TEXT;
ALTER TABLE jobs ADD COLUMN resolved_reference_ids TEXT CHECK(resolved_reference_ids IS NULL OR json_valid(resolved_reference_ids));
CREATE INDEX jobs_workspace_lookup ON jobs(workspace_id) WHERE workspace_id IS NOT NULL;
