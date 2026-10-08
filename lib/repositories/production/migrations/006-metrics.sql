CREATE TABLE metric_events(
  id TEXT PRIMARY KEY,
  project_id TEXT,
  workspace_id TEXT,
  kind TEXT NOT NULL,
  at INTEGER NOT NULL CHECK(typeof(at)='integer' AND at BETWEEN 0 AND 9007199254740991),
  duration_ms INTEGER CHECK(duration_ms IS NULL OR (typeof(duration_ms)='integer' AND duration_ms BETWEEN 0 AND 9007199254740991)),
  cost_micros INTEGER CHECK(cost_micros IS NULL OR (typeof(cost_micros)='integer' AND cost_micros>=0)),
  payload TEXT NOT NULL CHECK(json_valid(payload))
);
CREATE INDEX metric_events_project_kind_lookup ON metric_events(project_id,kind,at,id);
CREATE INDEX metric_events_workspace_lookup ON metric_events(workspace_id,at,id) WHERE workspace_id IS NOT NULL;
