CREATE TABLE auto_runs(
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  state TEXT NOT NULL,
  save_version INTEGER NOT NULL CHECK(typeof(save_version)='integer' AND save_version>0),
  created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 0 AND 9007199254740991),
  updated_at INTEGER NOT NULL CHECK(typeof(updated_at)='integer' AND updated_at BETWEEN 0 AND 9007199254740991),
  payload TEXT NOT NULL CHECK(json_valid(payload))
);
CREATE INDEX auto_runs_project_lookup ON auto_runs(project_id,updated_at DESC,id);
