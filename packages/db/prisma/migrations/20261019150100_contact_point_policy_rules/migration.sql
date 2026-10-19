-- Contact-point policy rules (auth-and-tenancy §4). packages/db/src/policy-defaults.json gained two unconditioned
-- `contact_point.edit` allow rules: one bound to the member, admin and owner roles (any team member may reach,
-- confirm, replace and restore a record's emails and phones), and one bound to the Nessie app wildcard
-- `agent:nessie:*` (a Nessie agent may do what its person may). New teams get them from seedDefaultPolicies; this
-- inserts the same rows for every team that already carries the seeded defaults. The rows match
-- seedDefaultPolicies' normalised comparison (team scope, created_by_id 'system', priority 0, no conditions, no
-- approval, the exact binding set), so a later resolve reports no drift. A team with no seeded defaults is left
-- alone: a partial seed would read as drift. Idempotent — a rule a team already holds is skipped, and only a team
-- that gained rules moves its policy_version, once. Nothing else changes: attribute.edit on confidential attributes
-- stays denied to members. One DO block, so the insert and its completeness check commit or fail together.
DO $$
BEGIN
  WITH seeded_teams AS (
    SELECT t.id, t.organization_id
    FROM teams t
    WHERE EXISTS (
      SELECT 1 FROM policy_rules r
      WHERE r.organization_id = t.organization_id AND r.team_id = t.id
        AND r.scope = 'team'::"PolicyScope" AND r.scope_id = t.id::text AND r.created_by_id = 'system'
    )
  ),
  wanted (rule_key, actor_type, actor_id) AS (
    VALUES
      ('roles', 'role', 'member'),
      ('roles', 'role', 'admin'),
      ('roles', 'role', 'owner'),
      ('nessie', 'agent', 'agent:nessie:*')
  ),
  -- One new rule id per team and missing rule; MATERIALIZED, so both inserts below see the same ids.
  missing AS MATERIALIZED (
    SELECT gen_random_uuid() AS rule_id, t.id AS team_id, t.organization_id, k.rule_key
    FROM seeded_teams t
    CROSS JOIN (SELECT DISTINCT rule_key FROM wanted) k
    WHERE NOT EXISTS (
      SELECT 1 FROM policy_rules r
      WHERE r.organization_id = t.organization_id AND r.team_id = t.id
        AND r.scope = 'team'::"PolicyScope" AND r.scope_id = t.id::text
        AND r.resource_type = 'contact_point'::"PolicyResourceType" AND r.action = 'edit'::"PolicyAction"
        AND r.effect = 'allow'::"PolicyEffect" AND r.priority = 0 AND r.conditions IS NULL
        AND r.requires_approval = false AND r.created_by_id = 'system'
        AND (
          SELECT array_agg(b.actor_type || ':' || b.actor_id ORDER BY b.actor_type, b.actor_id)
          FROM policy_bindings b WHERE b.policy_rule_id = r.id
        ) = (
          SELECT array_agg(w.actor_type || ':' || w.actor_id ORDER BY w.actor_type, w.actor_id)
          FROM wanted w WHERE w.rule_key = k.rule_key
        )
    )
  ),
  inserted_rules AS (
    INSERT INTO policy_rules (
      id, organization_id, team_id, scope, scope_id, resource_type, action,
      effect, priority, conditions, requires_approval, created_by_id, created_at
    )
    SELECT m.rule_id, m.organization_id, m.team_id, 'team'::"PolicyScope", m.team_id::text,
           'contact_point'::"PolicyResourceType", 'edit'::"PolicyAction", 'allow'::"PolicyEffect", 0, NULL, false,
           'system', CURRENT_TIMESTAMP
    FROM missing m
    RETURNING id, team_id
  ),
  inserted_bindings AS (
    INSERT INTO policy_bindings (id, policy_rule_id, actor_type, actor_id)
    SELECT gen_random_uuid(), r.id, w.actor_type, w.actor_id
    FROM inserted_rules r
    JOIN missing m ON m.rule_id = r.id
    JOIN wanted w ON w.rule_key = m.rule_key
    RETURNING policy_rule_id
  )
  UPDATE teams
  SET policy_version = policy_version + 1
  WHERE id IN (SELECT DISTINCT team_id FROM inserted_rules);

  -- Every seeded team now holds exactly the two rules, with four bindings between them.
  IF EXISTS (
    SELECT 1
    FROM teams t
    WHERE EXISTS (
      SELECT 1 FROM policy_rules r
      WHERE r.organization_id = t.organization_id AND r.team_id = t.id
        AND r.scope = 'team'::"PolicyScope" AND r.scope_id = t.id::text AND r.created_by_id = 'system'
    )
    AND (
      (
        SELECT count(*)
        FROM policy_rules r
        WHERE r.organization_id = t.organization_id AND r.team_id = t.id
          AND r.scope = 'team'::"PolicyScope" AND r.scope_id = t.id::text
          AND r.resource_type = 'contact_point'::"PolicyResourceType"
      ) <> 2
      OR (
        SELECT count(*)
        FROM policy_rules r
        JOIN policy_bindings b ON b.policy_rule_id = r.id
        WHERE r.organization_id = t.organization_id AND r.team_id = t.id
          AND r.scope = 'team'::"PolicyScope" AND r.scope_id = t.id::text
          AND r.resource_type = 'contact_point'::"PolicyResourceType"
      ) <> 4
    )
  ) THEN
    RAISE EXCEPTION 'contact point policy rules are incomplete';
  END IF;
END $$;
