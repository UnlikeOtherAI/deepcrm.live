-- Nessie agent policy bindings (docs/auth-and-tenancy.md §4). packages/db/src/policy-defaults.json
-- gained one unconditioned `allow` rule bound to the app wildcard `agent:nessie:*` for every
-- (resource_type, action) pair the code requests. New teams get them from seedDefaultPolicies;
-- this inserts the same rows for every team that already carries the seeded defaults. The rows
-- match seedDefaultPolicies' normalised comparison (team scope, created_by_id 'system', priority
-- 0, no conditions, no approval), so a later resolve reports no drift. A team with no seeded
-- defaults is left alone: a partial seed would read as drift. Idempotent — a pair that already
-- holds the rule is skipped, and only a team that gained rules moves its policy_version, once.
-- One DO block, so the insert and its completeness check commit or fail together.
DO $$
BEGIN
  WITH pairs (resource_type, action) AS (
    VALUES
      ('record'::"PolicyResourceType", 'view'::"PolicyAction"),
      ('record'::"PolicyResourceType", 'create'::"PolicyAction"),
      ('record'::"PolicyResourceType", 'edit'::"PolicyAction"),
      ('record'::"PolicyResourceType", 'link'::"PolicyAction"),
      ('record'::"PolicyResourceType", 'delete'::"PolicyAction"),
      ('record'::"PolicyResourceType", 'restore'::"PolicyAction"),
      ('record'::"PolicyResourceType", 'erase'::"PolicyAction"),
      ('link'::"PolicyResourceType", 'view'::"PolicyAction"),
      ('link'::"PolicyResourceType", 'link'::"PolicyAction"),
      ('list'::"PolicyResourceType", 'view'::"PolicyAction"),
      ('list'::"PolicyResourceType", 'create'::"PolicyAction"),
      ('list'::"PolicyResourceType", 'edit'::"PolicyAction"),
      ('view'::"PolicyResourceType", 'view'::"PolicyAction"),
      ('view'::"PolicyResourceType", 'create'::"PolicyAction"),
      ('view'::"PolicyResourceType", 'edit'::"PolicyAction"),
      ('schema'::"PolicyResourceType", 'view'::"PolicyAction"),
      ('schema'::"PolicyResourceType", 'define'::"PolicyAction"),
      ('attribute'::"PolicyResourceType", 'view'::"PolicyAction"),
      ('attribute'::"PolicyResourceType", 'edit'::"PolicyAction"),
      ('merge'::"PolicyResourceType", 'merge'::"PolicyAction"),
      ('export'::"PolicyResourceType", 'export'::"PolicyAction"),
      ('webhook'::"PolicyResourceType", 'admin'::"PolicyAction"),
      ('suppression'::"PolicyResourceType", 'view'::"PolicyAction"),
      ('suppression'::"PolicyResourceType", 'create'::"PolicyAction"),
      ('suppression'::"PolicyResourceType", 'admin'::"PolicyAction"),
      ('approval'::"PolicyResourceType", 'admin'::"PolicyAction")
  ),
  seeded_teams AS (
    SELECT t.id, t.organization_id
    FROM teams t
    WHERE EXISTS (
      SELECT 1 FROM policy_rules r
      WHERE r.organization_id = t.organization_id AND r.team_id = t.id
        AND r.scope = 'team'::"PolicyScope" AND r.scope_id = t.id::text AND r.created_by_id = 'system'
    )
  ),
  inserted_rules AS (
    INSERT INTO policy_rules (
      id, organization_id, team_id, scope, scope_id, resource_type, action,
      effect, priority, conditions, requires_approval, created_by_id, created_at
    )
    SELECT gen_random_uuid(), t.organization_id, t.id, 'team'::"PolicyScope", t.id::text,
           p.resource_type, p.action, 'allow'::"PolicyEffect", 0, NULL, false, 'system', CURRENT_TIMESTAMP
    FROM seeded_teams t
    CROSS JOIN pairs p
    WHERE NOT EXISTS (
      SELECT 1 FROM policy_rules r
      JOIN policy_bindings b ON b.policy_rule_id = r.id
      WHERE r.organization_id = t.organization_id AND r.team_id = t.id
        AND r.scope = 'team'::"PolicyScope" AND r.scope_id = t.id::text
        AND r.resource_type = p.resource_type AND r.action = p.action
        AND r.effect = 'allow'::"PolicyEffect" AND r.priority = 0 AND r.conditions IS NULL
        AND r.requires_approval = false AND r.created_by_id = 'system'
        AND b.actor_type = 'agent' AND b.actor_id = 'agent:nessie:*'
    )
    RETURNING id, team_id
  ),
  inserted_bindings AS (
    INSERT INTO policy_bindings (id, policy_rule_id, actor_type, actor_id)
    SELECT gen_random_uuid(), r.id, 'agent', 'agent:nessie:*'
    FROM inserted_rules r
    RETURNING policy_rule_id
  )
  UPDATE teams
  SET policy_version = policy_version + 1
  WHERE id IN (SELECT DISTINCT team_id FROM inserted_rules);

  IF EXISTS (
    SELECT 1
    FROM teams t
    WHERE EXISTS (
      SELECT 1 FROM policy_rules r
      WHERE r.organization_id = t.organization_id AND r.team_id = t.id
        AND r.scope = 'team'::"PolicyScope" AND r.scope_id = t.id::text AND r.created_by_id = 'system'
    )
    AND (
      SELECT count(*)
      FROM policy_rules r
      JOIN policy_bindings b ON b.policy_rule_id = r.id
      WHERE r.organization_id = t.organization_id AND r.team_id = t.id
        AND r.scope = 'team'::"PolicyScope" AND r.scope_id = t.id::text
        AND b.actor_type = 'agent' AND b.actor_id = 'agent:nessie:*'
    ) <> 26
  ) THEN
    RAISE EXCEPTION 'nessie agent policy bindings are incomplete';
  END IF;
END $$;
