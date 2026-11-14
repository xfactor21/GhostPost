CREATE SCHEMA IF NOT EXISTS ghostpost;
CREATE TABLE IF NOT EXISTS ghostpost.records (
 namespace text NOT NULL,
 id text NOT NULL,
 data jsonb NOT NULL CHECK(jsonb_typeof(data) = 'object'),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(namespace,id)
);
