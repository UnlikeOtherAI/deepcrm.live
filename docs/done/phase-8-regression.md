# Phase 8 regression loop

- Commit SHA: a8d4c3c1445f8dbed5dc237259b50104b835b507
- Disposable database: deepcrm_t67_loop_20260825031502 (dropped by script cleanup)
- API port: 63578
- Tools exercised: 75/75
- Resources read: crm://help/filtering, crm://help/limits, crm://schema, crm://templates, crm://views
- Prompts discovered: crm/clean-duplicates, crm/prepare-account-review, crm/qualify-lead
- Worker jobs: [
  {
    "_count": {
      "_all": 28
    },
    "type": "derived.refresh",
    "status": "completed"
  },
  {
    "_count": {
      "_all": 16
    },
    "type": "list.refresh",
    "status": "completed"
  },
  {
    "_count": {
      "_all": 1
    },
    "type": "match-key-backfill",
    "status": "completed"
  },
  {
    "_count": {
      "_all": 73
    },
    "type": "record.reindex",
    "status": "completed"
  },
  {
    "_count": {
      "_all": 1
    },
    "type": "records.bulk_assert",
    "status": "completed"
  },
  {
    "_count": {
      "_all": 1
    },
    "type": "records.dedup_scan",
    "status": "completed"
  },
  {
    "_count": {
      "_all": 1
    },
    "type": "records.export",
    "status": "completed"
  }
]
- Audit verification: passed
- Cleanup: API/worker stopped; database dropped; port checked by script

## Redacted Result Shapes

{
  "crm_activity_log": {
    "status": "ok",
    "shape": {
      "record": {
        "id": "string",
        "object_type": "string",
        "display_name": "string",
        "version": "number",
        "data": {
          "direction": "string",
          "kind": "string",
          "occurred_at": "string",
          "subject": "string"
        },
        "visibility": "string",
        "origin": "null",
        "owner": "null",
        "created_at": "string",
        "updated_at": "string",
        "last_activity_at": "null",
        "redacted_attributes": []
      }
    }
  },
  "crm_attribute_archive": {
    "status": "ok",
    "shape": {
      "archived": "boolean",
      "records_with_values": "number"
    }
  },
  "crm_attribute_define": {
    "status": "ok",
    "shape": {
      "slug": "string",
      "name": "string",
      "description": "string",
      "type": "string",
      "config": {
        "maxLength": "number"
      },
      "is_multi": "boolean",
      "is_required": "boolean",
      "is_unique": "boolean",
      "is_indexed": "boolean",
      "sensitivity": "string",
      "default_value": "undefined",
      "id": "string",
      "value_source": "string",
      "derivation": "null",
      "group": "null",
      "is_system": "boolean",
      "position": "number",
      "archived_at": "null"
    }
  },
  "crm_attribute_group_archive": {
    "status": "ok",
    "shape": {
      "archived": "boolean"
    }
  },
  "crm_attribute_group_define": {
    "status": "ok",
    "shape": {
      "id": "string",
      "object_type": "string",
      "slug": "string",
      "name": "string",
      "description": "string",
      "position": "number",
      "archived_at": "null"
    }
  },
  "crm_attribute_group_reorder": {
    "status": "ok",
    "shape": {
      "groups": [
        {
          "id": "string",
          "object_type": "string",
          "slug": "string",
          "name": "string",
          "description": "string",
          "position": "number",
          "archived_at": "null"
        }
      ]
    }
  },
  "crm_attribute_update": {
    "status": "ok",
    "shape": {
      "slug": "string",
      "name": "string",
      "description": "string",
      "type": "string",
      "config": {
        "maxLength": "number"
      },
      "is_multi": "boolean",
      "is_required": "boolean",
      "is_unique": "boolean",
      "is_indexed": "boolean",
      "sensitivity": "string",
      "default_value": "undefined",
      "id": "string",
      "value_source": "string",
      "derivation": "null",
      "group": "null",
      "is_system": "boolean",
      "position": "number",
      "archived_at": "null"
    }
  },
  "crm_changes_since": {
    "status": "ok",
    "shape": {
      "changes": [
        {
          "id": "string",
          "event": "string",
          "seq": "string",
          "resulting_version": "number",
          "record": {
            "id": "string",
            "object_type": "string",
            "display_name": "string"
          },
          "group_id": "null",
          "kind": "string",
          "attribute": "null",
          "relation_type": "null",
          "link_id": "null",
          "actor": {
            "type": "string",
            "id": "string"
          },
          "on_behalf_of": "string",
          "provenance": {
            "run_id": "string",
            "tool_call_id": "string",
            "request_id": "string"
          },
          "reason": "null",
          "occurred_at": "string"
        }
      ],
      "next_cursor": "string",
      "has_more": "boolean"
    }
  },
  "crm_data_quality": {
    "status": "ok",
    "shape": {
      "missing_required": {
        "count": "number",
        "items": [],
        "query_filter": {
          "quality": {
            "category": "string"
          }
        }
      },
      "stale": {
        "count": "number",
        "items": [],
        "query_filter": {
          "quality": {
            "category": "string",
            "stale_days": "number"
          }
        }
      },
      "orphans": {
        "count": "number",
        "items": [],
        "query_filter": {
          "quality": {
            "category": "string"
          }
        }
      },
      "collisions": {
        "count": "number",
        "items": [],
        "query_filter": {
          "quality": {
            "category": "string"
          }
        }
      }
    }
  },
  "crm_derived_attribute_define": {
    "status": "ok",
    "shape": {
      "slug": "string",
      "name": "string",
      "description": "string",
      "type": "string",
      "config": {
        "maxLength": "number"
      },
      "is_multi": "boolean",
      "is_required": "boolean",
      "is_unique": "boolean",
      "is_indexed": "boolean",
      "sensitivity": "string",
      "default_value": "undefined",
      "id": "string",
      "value_source": "string",
      "derivation": {
        "attribute": "string",
        "type": "string",
        "sensitivity": "string",
        "value_source": "string",
        "materialized": "boolean",
        "config": {
          "expression": {
            "kind": "string",
            "value": "string"
          },
          "null_behavior": "string",
          "error_behavior": "string"
        },
        "refresh_state": "string",
        "refresh_error_code": "null",
        "last_refreshed_at": "null",
        "dependencies": []
      },
      "group": "null",
      "is_system": "boolean",
      "position": "number",
      "archived_at": "null"
    }
  },
  "crm_derived_attribute_update": {
    "status": "ok",
    "shape": {
      "slug": "string",
      "name": "string",
      "description": "string",
      "type": "string",
      "config": {
        "maxLength": "number"
      },
      "is_multi": "boolean",
      "is_required": "boolean",
      "is_unique": "boolean",
      "is_indexed": "boolean",
      "sensitivity": "string",
      "default_value": "undefined",
      "id": "string",
      "value_source": "string",
      "derivation": {
        "attribute": "string",
        "type": "string",
        "sensitivity": "string",
        "value_source": "string",
        "materialized": "boolean",
        "config": {
          "expression": {
            "kind": "string",
            "value": "string"
          },
          "null_behavior": "string",
          "error_behavior": "string"
        },
        "refresh_state": "string",
        "refresh_error_code": "null",
        "last_refreshed_at": "null",
        "dependencies": []
      },
      "group": "null",
      "is_system": "boolean",
      "position": "number",
      "archived_at": "null"
    }
  },
  "crm_derived_refresh_status": {
    "status": "ok",
    "shape": {
      "attributes": [
        {
          "attribute": "string",
          "type": "string",
          "sensitivity": "string",
          "value_source": "string",
          "materialized": "boolean",
          "config": {
            "expression": {
              "kind": "string",
              "value": "string"
            },
            "null_behavior": "string",
            "error_behavior": "string"
          },
          "refresh_state": "string",
          "refresh_error_code": "null",
          "last_refreshed_at": "null",
          "dependencies": []
        }
      ]
    }
  },
  "crm_event_ingest": {
    "status": "ok",
    "shape": {
      "event": {
        "id": "string",
        "event_type": "string",
        "source": "string",
        "external_id": "string",
        "occurred_at": "string",
        "subject_record_id": "string",
        "actor": "null",
        "properties": {
          "feature": "string"
        },
        "correction_of_event_id": "null"
      },
      "created": "boolean"
    }
  },
  "crm_event_type_define": {
    "status": "ok",
    "shape": {
      "event_type": {
        "id": "string",
        "slug": "string",
        "name": "string",
        "description": "string",
        "subject_object_type": "null",
        "property_schema": {
          "type": "string",
          "properties": {
            "feature": {
              "type": "string"
            }
          },
          "additionalProperties": "boolean"
        },
        "archived_at": "null"
      }
    }
  },
  "crm_events_query": {
    "status": "expected_error",
    "shape": {
      "code": "string",
      "message": "string",
      "next": "string"
    }
  },
  "crm_export": {
    "status": "ok",
    "shape": {
      "task": {
        "taskId": "string",
        "status": "string",
        "ttl": "number",
        "createdAt": "string",
        "lastUpdatedAt": "string",
        "pollInterval": "number"
      }
    }
  },
  "crm_file_link": {
    "status": "ok",
    "shape": {
      "link": {
        "id": "string",
        "file_id": "string",
        "target_type": "string",
        "record_id": "string",
        "event_id": "null",
        "purpose": "string",
        "metadata": {}
      }
    }
  },
  "crm_file_list": {
    "status": "ok",
    "shape": {
      "files": [
        {
          "file": {
            "id": "string",
            "provider": "string",
            "provider_key": "string",
            "filename": "string",
            "mime_type": "string",
            "size_bytes": "string",
            "checksum_sha256": "string",
            "metadata": {},
            "created_at": "string"
          },
          "link": {
            "id": "string",
            "file_id": "string",
            "target_type": "string",
            "record_id": "string",
            "event_id": "null",
            "purpose": "string",
            "metadata": {}
          },
          "access": {
            "url": "string",
            "expires_at": "string"
          }
        }
      ]
    }
  },
  "crm_file_register": {
    "status": "ok",
    "shape": {
      "file": {
        "id": "string",
        "provider": "string",
        "provider_key": "string",
        "filename": "string",
        "mime_type": "string",
        "size_bytes": "string",
        "checksum_sha256": "string",
        "metadata": {},
        "created_at": "string"
      }
    }
  },
  "crm_find_duplicates": {
    "status": "ok",
    "shape": {
      "task": {
        "taskId": "string",
        "status": "string",
        "ttl": "number",
        "createdAt": "string",
        "lastUpdatedAt": "string",
        "pollInterval": "number"
      }
    }
  },
  "crm_link": {
    "status": "ok",
    "shape": {
      "link": {
        "id": "string",
        "relation_type": "string",
        "from_record_id": "string",
        "to_record_id": "string",
        "label": "null",
        "data": {},
        "active_from": "string",
        "active_until": "null"
      },
      "ended_links": []
    }
  },
  "crm_links_list": {
    "status": "ok",
    "shape": {
      "links": [
        {
          "link": {
            "id": "string",
            "relation_type": "string",
            "from_record_id": "string",
            "to_record_id": "string",
            "label": "null",
            "data": {},
            "active_from": "string",
            "active_until": "null"
          },
          "related": {
            "id": "string",
            "object_type": "string",
            "display_name": "string"
          }
        }
      ],
      "next_cursor": "null"
    }
  },
  "crm_list_add": {
    "status": "ok",
    "shape": {
      "added": "number"
    }
  },
  "crm_list_create": {
    "status": "ok",
    "shape": {
      "id": "string",
      "slug": "string",
      "name": "string",
      "description": "string",
      "kind": "string",
      "object_type": "string",
      "definition": {
        "list": "string",
        "object_type": "string",
        "filter": {
          "attribute": "string",
          "op": "string",
          "value": "string"
        },
        "evaluation_version": "number",
        "refresh_state": "string",
        "refresh_error_code": "null",
        "last_evaluated_at": "null"
      },
      "refresh_state": "string",
      "refresh_error_code": "null",
      "last_evaluated_at": "null",
      "attributes": [],
      "entry_count": "number"
    }
  },
  "crm_list_entries": {
    "status": "ok",
    "shape": {
      "entries": [
        {
          "entry": {
            "id": "string",
            "data": {},
            "position": "number"
          },
          "record": {
            "id": "string",
            "object_type": "string",
            "display_name": "string",
            "version": "number",
            "data": {
              "domains": [
                "string"
              ],
              "name": "string"
            },
            "visibility": "string",
            "origin": "null",
            "owner": "null",
            "created_at": "string",
            "updated_at": "string",
            "last_activity_at": "null",
            "redacted_attributes": []
          }
        }
      ],
      "next_cursor": "null",
      "list": {
        "kind": "string",
        "refresh_state": "string",
        "evaluation_version": "number"
      }
    }
  },
  "crm_list_remove": {
    "status": "ok",
    "shape": {
      "removed": "number"
    }
  },
  "crm_list_status": {
    "status": "ok",
    "shape": {
      "status": {
        "list": "string",
        "object_type": "string",
        "filter": {
          "attribute": "string",
          "op": "string",
          "value": "string"
        },
        "evaluation_version": "number",
        "refresh_state": "string",
        "refresh_error_code": "null",
        "last_evaluated_at": "null"
      }
    }
  },
  "crm_list_update": {
    "status": "ok",
    "shape": {
      "id": "string",
      "slug": "string",
      "name": "string",
      "description": "string",
      "kind": "string",
      "object_type": "string",
      "definition": {
        "list": "string",
        "object_type": "string",
        "filter": {
          "attribute": "string",
          "op": "string",
          "value": "string"
        },
        "evaluation_version": "number",
        "refresh_state": "string",
        "refresh_error_code": "null",
        "last_evaluated_at": "null"
      },
      "refresh_state": "string",
      "refresh_error_code": "null",
      "last_evaluated_at": "null",
      "attributes": [],
      "entry_count": "number"
    }
  },
  "crm_matching_rule_set": {
    "status": "ok",
    "shape": {
      "rules": [
        {
          "attributes": [
            "string"
          ],
          "method": "string",
          "action": "string"
        }
      ],
      "activation": {
        "state": "string",
        "taskId": "string"
      }
    }
  },
  "crm_merge_records": {
    "status": "ok",
    "shape": {
      "record": {
        "id": "string",
        "object_type": "string",
        "display_name": "string",
        "version": "number",
        "data": {
          "domains": [
            "string"
          ],
          "name": "string"
        },
        "visibility": "string",
        "origin": "null",
        "owner": "null",
        "created_at": "string",
        "updated_at": "string",
        "last_activity_at": "string",
        "redacted_attributes": []
      },
      "merge_change_id": "string",
      "repointed_links": "number",
      "ended_links": []
    }
  },
  "crm_note_add": {
    "status": "ok",
    "shape": {
      "record": {
        "id": "string",
        "object_type": "string",
        "display_name": "string",
        "version": "number",
        "data": {
          "body": "string",
          "title": "string"
        },
        "visibility": "string",
        "origin": "null",
        "owner": "null",
        "created_at": "string",
        "updated_at": "string",
        "last_activity_at": "null",
        "redacted_attributes": []
      }
    }
  },
  "crm_object_type_archive": {
    "status": "ok",
    "shape": {
      "archived": "boolean",
      "records": "number"
    }
  },
  "crm_object_type_define": {
    "status": "ok",
    "shape": {
      "id": "string",
      "slug": "string",
      "singular_name": "string",
      "plural_name": "string",
      "description": "string",
      "icon": "null",
      "kind": "string",
      "primary_attribute": "null",
      "attribute_groups": [],
      "attributes": [],
      "relation_types": [],
      "pipelines": [],
      "archived_at": "null"
    }
  },
  "crm_object_type_update": {
    "status": "ok",
    "shape": {
      "id": "string",
      "slug": "string",
      "singular_name": "string",
      "plural_name": "string",
      "description": "string",
      "icon": "null",
      "kind": "string",
      "primary_attribute": "null",
      "attribute_groups": [],
      "attributes": [],
      "relation_types": [],
      "pipelines": [],
      "archived_at": "null"
    }
  },
  "crm_pipeline_define": {
    "status": "ok",
    "shape": {
      "id": "string",
      "object_type": "string",
      "slug": "string",
      "name": "string",
      "description": "string",
      "is_default": "boolean",
      "stages": [
        {
          "id": "string",
          "slug": "string",
          "name": "string",
          "position": "number",
          "probability": "null",
          "category": "string",
          "archived_at": "null"
        }
      ],
      "archived_at": "null"
    }
  },
  "crm_pipeline_stage_set": {
    "status": "ok",
    "shape": {
      "record_id": "string",
      "pipeline": "string",
      "stage": "string",
      "changed": "boolean",
      "interval_id": "string"
    }
  },
  "crm_pipeline_stages_list": {
    "status": "ok",
    "shape": {
      "pipeline": {
        "id": "string",
        "object_type": "string",
        "slug": "string",
        "name": "string",
        "description": "string",
        "is_default": "boolean",
        "stages": [
          {
            "id": "string",
            "slug": "string",
            "name": "string",
            "position": "number",
            "probability": "null",
            "category": "string",
            "archived_at": "null"
          }
        ],
        "archived_at": "null"
      },
      "stages": [
        {
          "id": "string",
          "slug": "string",
          "name": "string",
          "position": "number",
          "probability": "null",
          "category": "string",
          "archived_at": "null"
        }
      ]
    }
  },
  "crm_pipeline_summary": {
    "status": "ok",
    "shape": {
      "stages": [
        {
          "id": "string",
          "label": "string",
          "category": "string",
          "count": "number",
          "amount_sum": "null",
          "avg_days_in_stage": "null"
        }
      ],
      "conversions": []
    }
  },
  "crm_pipeline_update": {
    "status": "ok",
    "shape": {
      "id": "string",
      "object_type": "string",
      "slug": "string",
      "name": "string",
      "description": "string",
      "is_default": "boolean",
      "stages": [
        {
          "id": "string",
          "slug": "string",
          "name": "string",
          "position": "number",
          "probability": "null",
          "category": "string",
          "archived_at": "null"
        }
      ],
      "archived_at": "null"
    }
  },
  "crm_record_assert": {
    "status": "ok",
    "shape": {
      "record": {
        "id": "string",
        "object_type": "string",
        "display_name": "string",
        "version": "number",
        "data": {
          "balance_due": {
            "amount": "string",
            "currency": "string"
          },
          "due_date": "string",
          "invoice_number": "string",
          "issue_date": "string",
          "name": "string",
          "status": "string",
          "total_amount": {
            "amount": "string",
            "currency": "string"
          }
        },
        "visibility": "string",
        "origin": "null",
        "owner": "null",
        "created_at": "string",
        "updated_at": "string",
        "last_activity_at": "null",
        "redacted_attributes": []
      },
      "created": "boolean"
    }
  },
  "crm_record_at": {
    "status": "ok",
    "shape": {
      "record_at": {
        "data": {
          "domains": [
            "string"
          ],
          "name": "string"
        },
        "links": {},
        "version_at": "number",
        "as_of": "string"
      }
    }
  },
  "crm_record_create": {
    "status": "expected_error",
    "shape": {
      "attribute": "string",
      "code": "string",
      "message": "string",
      "next": "string"
    }
  },
  "crm_record_delete": {
    "status": "ok",
    "shape": {
      "deleted": "boolean"
    }
  },
  "crm_record_erase": {
    "status": "ok",
    "shape": {
      "erased": "boolean",
      "suppressed": [
        {
          "kind": "string",
          "count": "number"
        }
      ]
    }
  },
  "crm_record_get": {
    "status": "expected_error",
    "shape": {
      "code": "string",
      "message": "string",
      "next": "string"
    }
  },
  "crm_record_history": {
    "status": "ok",
    "shape": {
      "changes": [
        {
          "id": "string",
          "seq": "string",
          "resulting_version": "number",
          "record": {
            "id": "string",
            "object_type": "string",
            "display_name": "string"
          },
          "group_id": "string",
          "kind": "string",
          "attribute": "null",
          "relation_type": "string",
          "link_id": "string",
          "new_value": {
            "data": {},
            "from_record_id": "string",
            "position": "null",
            "to_record_id": "string"
          },
          "actor": {
            "type": "string",
            "id": "string"
          },
          "on_behalf_of": "string",
          "provenance": {
            "run_id": "string",
            "tool_call_id": "string",
            "request_id": "string"
          },
          "reason": "null",
          "occurred_at": "string"
        }
      ],
      "next_cursor": "null"
    }
  },
  "crm_record_restore": {
    "status": "ok",
    "shape": {
      "record": {
        "id": "string",
        "object_type": "string",
        "display_name": "string",
        "version": "number",
        "data": {
          "domains": [
            "string"
          ],
          "name": "string"
        },
        "visibility": "string",
        "origin": "null",
        "owner": "null",
        "created_at": "string",
        "updated_at": "string",
        "last_activity_at": "null",
        "redacted_attributes": []
      }
    }
  },
  "crm_record_timeline": {
    "status": "ok",
    "shape": {
      "items": [
        {
          "kind": "string",
          "record": {
            "id": "string",
            "object_type": "string",
            "display_name": "string",
            "version": "number",
            "data": {
              "body": "string",
              "title": "string"
            },
            "visibility": "string",
            "origin": "null",
            "owner": "null",
            "created_at": "string",
            "updated_at": "string",
            "last_activity_at": "null",
            "redacted_attributes": []
          },
          "about": [
            {
              "id": "string",
              "object_type": "string",
              "display_name": "string"
            }
          ],
          "occurred_at": "string"
        }
      ],
      "next_cursor": "null"
    }
  },
  "crm_record_update": {
    "status": "ok",
    "shape": {
      "record": {
        "id": "string",
        "object_type": "string",
        "display_name": "string",
        "version": "number",
        "data": {
          "line_item_count": "string",
          "name": "string",
          "quote_number": "string",
          "status": "string",
          "total_amount": {
            "amount": "string",
            "currency": "string"
          }
        },
        "visibility": "string",
        "origin": "null",
        "owner": "null",
        "created_at": "string",
        "updated_at": "string",
        "last_activity_at": "null",
        "redacted_attributes": []
      }
    }
  },
  "crm_records_bulk_assert": {
    "status": "ok",
    "shape": {
      "task": {
        "taskId": "string",
        "status": "string",
        "ttl": "number",
        "createdAt": "string",
        "lastUpdatedAt": "string",
        "pollInterval": "number"
      }
    }
  },
  "crm_records_count": {
    "status": "ok",
    "shape": {
      "count": "number"
    }
  },
  "crm_records_get_many": {
    "status": "ok",
    "shape": {
      "records": [
        {
          "id": "string",
          "object_type": "string",
          "display_name": "string",
          "version": "number",
          "data": {
            "domains": [
              "string"
            ],
            "name": "string"
          },
          "visibility": "string",
          "origin": "null",
          "owner": "null",
          "created_at": "string",
          "updated_at": "string",
          "last_activity_at": "null",
          "redacted_attributes": []
        }
      ],
      "missing": []
    }
  },
  "crm_records_query": {
    "status": "ok",
    "shape": {
      "records": [
        {
          "id": "string",
          "object_type": "string",
          "display_name": "string",
          "version": "number",
          "data": {
            "billing_frequency": "string",
            "invoice": "string",
            "name": "string",
            "order": "string",
            "product": "string",
            "quantity": "string",
            "quote": "string",
            "sku": "string",
            "snapshot_at": "string",
            "subscription": "string",
            "total_amount": {
              "amount": "string",
              "currency": "string"
            },
            "unit_price": {
              "amount": "string",
              "currency": "string"
            }
          },
          "visibility": "string",
          "origin": "null",
          "owner": "null",
          "created_at": "string",
          "updated_at": "string",
          "last_activity_at": "null",
          "redacted_attributes": []
        }
      ],
      "next_cursor": "null"
    }
  },
  "crm_relation_type_archive": {
    "status": "ok",
    "shape": {
      "archived": "boolean",
      "links": "number"
    }
  },
  "crm_relation_type_define": {
    "status": "ok",
    "shape": {
      "id": "string",
      "slug": "string",
      "from_object_type": "string",
      "to_object_type": "string",
      "forward_name": "string",
      "inverse_name": "string",
      "description": "string",
      "cardinality": "string",
      "edge_limits": {
        "max_active_edges_from": "null",
        "max_active_edges_to": "null",
        "label_limits": {}
      },
      "on_delete": "string",
      "edge_attributes": [],
      "is_system": "boolean",
      "archived_at": "null"
    }
  },
  "crm_relation_type_update": {
    "status": "ok",
    "shape": {
      "id": "string",
      "slug": "string",
      "from_object_type": "string",
      "to_object_type": "string",
      "forward_name": "string",
      "inverse_name": "string",
      "description": "string",
      "cardinality": "string",
      "edge_limits": {
        "max_active_edges_from": "null",
        "max_active_edges_to": "null",
        "label_limits": {}
      },
      "on_delete": "string",
      "edge_attributes": [],
      "is_system": "boolean",
      "archived_at": "null"
    }
  },
  "crm_schema_get": {
    "status": "ok",
    "shape": {
      "schema_version": "number",
      "object_types": [
        {
          "id": "string",
          "slug": "string",
          "singular_name": "string",
          "plural_name": "string",
          "description": "string",
          "kind": "string",
          "primary_attribute": "string",
          "attribute_count": "number"
        }
      ],
      "relation_types": [
        {
          "id": "string",
          "slug": "string",
          "from_object_type": "string",
          "to_object_type": "null",
          "forward_name": "string",
          "inverse_name": "string",
          "description": "string",
          "cardinality": "string",
          "edge_limits": {
            "max_active_edges_from": "null",
            "max_active_edges_to": "null",
            "label_limits": {}
          },
          "on_delete": "string",
          "edge_attributes": [],
          "is_system": "boolean",
          "archived_at": "null"
        }
      ],
      "matching_rules": {
        "activity": [],
        "company": [
          {
            "attributes": [
              "string"
            ],
            "method": "string",
            "threshold": "undefined",
            "action": "string"
          }
        ],
        "deal": [
          {
            "attributes": [
              "string"
            ],
            "method": "string",
            "threshold": "undefined",
            "action": "string"
          }
        ],
        "invoice": [
          {
            "attributes": [
              "string"
            ],
            "method": "string",
            "threshold": "undefined",
            "action": "string"
          }
        ],
        "lead": [
          {
            "attributes": [
              "string"
            ],
            "method": "string",
            "threshold": "undefined",
            "action": "string"
          }
        ],
        "line_item": [
          {
            "attributes": [
              "string"
            ],
            "method": "string",
            "threshold": "undefined",
            "action": "string"
          }
        ],
        "note": [],
        "order": [
          {
            "attributes": [
              "string"
            ],
            "method": "string",
            "threshold": "undefined",
            "action": "string"
          }
        ],
        "payment": [
          {
            "attributes": [
              "string"
            ],
            "method": "string",
            "threshold": "undefined",
            "action": "string"
          }
        ],
        "person": [
          {
            "attributes": [
              "string"
            ],
            "method": "string",
            "threshold": "undefined",
            "action": "string"
          }
        ],
        "product": [
          {
            "attributes": [
              "string"
            ],
            "method": "string",
            "threshold": "undefined",
            "action": "string"
          }
        ],
        "quote": [
          {
            "attributes": [
              "string"
            ],
            "method": "string",
            "threshold": "undefined",
            "action": "string"
          }
        ],
        "subscription": [
          {
            "attributes": [
              "string"
            ],
            "method": "string",
            "threshold": "undefined",
            "action": "string"
          }
        ],
        "task": [],
        "ticket": [
          {
            "attributes": [
              "string"
            ],
            "method": "string",
            "threshold": "undefined",
            "action": "string"
          }
        ]
      },
      "views": []
    }
  },
  "crm_search": {
    "status": "ok",
    "shape": {
      "hits": [
        {
          "record": {
            "id": "string",
            "object_type": "string",
            "display_name": "string"
          },
          "score": "number",
          "match": "string"
        }
      ]
    }
  },
  "crm_suppression_add": {
    "status": "ok",
    "shape": {
      "added": "boolean"
    }
  },
  "crm_suppression_check": {
    "status": "ok",
    "shape": {
      "results": [
        {
          "kind": "string",
          "suppressed": "boolean",
          "reason": "string"
        }
      ]
    }
  },
  "crm_suppression_list": {
    "status": "ok",
    "shape": {
      "entries": [
        {
          "kind": "string",
          "channel": "string",
          "key_hash": "string",
          "reason": "string",
          "sub_reason": "null",
          "expires_at": "null",
          "note": "null",
          "created_at": "string"
        }
      ],
      "next_cursor": "null"
    }
  },
  "crm_suppression_remove": {
    "status": "ok",
    "shape": {
      "removed": "boolean"
    }
  },
  "crm_task_create": {
    "status": "ok",
    "shape": {
      "record": {
        "id": "string",
        "object_type": "string",
        "display_name": "string",
        "version": "number",
        "data": {
          "assignee": {
            "id": "string",
            "type": "string"
          },
          "priority": "string",
          "status": "string",
          "title": "string"
        },
        "visibility": "string",
        "origin": "null",
        "owner": "null",
        "created_at": "string",
        "updated_at": "string",
        "last_activity_at": "null",
        "redacted_attributes": []
      }
    }
  },
  "crm_task_update": {
    "status": "ok",
    "shape": {
      "record": {
        "id": "string",
        "object_type": "string",
        "display_name": "string",
        "version": "number",
        "data": {
          "assignee": {
            "id": "string",
            "type": "string"
          },
          "priority": "string",
          "status": "string",
          "title": "string"
        },
        "visibility": "string",
        "origin": "null",
        "owner": "null",
        "created_at": "string",
        "updated_at": "string",
        "last_activity_at": "null",
        "redacted_attributes": []
      }
    }
  },
  "crm_tasks_list": {
    "status": "ok",
    "shape": {
      "records": [
        {
          "id": "string",
          "object_type": "string",
          "display_name": "string",
          "version": "number",
          "data": {
            "assignee": {
              "id": "string",
              "type": "string"
            },
            "priority": "string",
            "status": "string",
            "title": "string"
          },
          "visibility": "string",
          "origin": "null",
          "owner": "null",
          "created_at": "string",
          "updated_at": "string",
          "last_activity_at": "null",
          "redacted_attributes": []
        }
      ],
      "next_cursor": "null"
    }
  },
  "crm_template_apply": {
    "status": "ok",
    "shape": {
      "added": {
        "object_types": "number",
        "attributes": "number",
        "relation_types": "number",
        "pipelines": "number",
        "matching_rules": "number"
      }
    }
  },
  "crm_unlink": {
    "status": "ok",
    "shape": {
      "link_id": "string"
    }
  },
  "crm_unmerge": {
    "status": "ok",
    "shape": {
      "restored": [
        "string"
      ],
      "conflicts": []
    }
  },
  "crm_view_delete": {
    "status": "ok",
    "shape": {
      "deleted": "boolean"
    }
  },
  "crm_view_run": {
    "status": "ok",
    "shape": {
      "records": [
        {
          "id": "string",
          "object_type": "string",
          "display_name": "string",
          "version": "number",
          "data": {
            "name": "string",
            "sku": "string"
          },
          "visibility": "string",
          "origin": "null",
          "owner": "null",
          "created_at": "string",
          "updated_at": "string",
          "last_activity_at": "null",
          "redacted_attributes": []
        }
      ],
      "next_cursor": "null"
    }
  },
  "crm_view_save": {
    "status": "ok",
    "shape": {
      "id": "string",
      "slug": "string",
      "name": "string",
      "description": "string",
      "object_type": "string",
      "filter": {
        "attribute": "string",
        "op": "string",
        "value": "string"
      },
      "sort": [
        {
          "system": "string",
          "direction": "string"
        }
      ],
      "attributes": [
        "string"
      ]
    }
  },
  "crm_webhook_delete": {
    "status": "ok",
    "shape": {
      "deleted": "boolean"
    }
  },
  "crm_webhook_list": {
    "status": "ok",
    "shape": {
      "webhooks": [
        {
          "id": "string",
          "url": "string",
          "events": [
            "string"
          ],
          "active": "boolean",
          "last_error": "null"
        }
      ]
    }
  },
  "crm_webhook_set": {
    "status": "ok",
    "shape": {
      "webhook": {
        "id": "string",
        "url": "string",
        "events": [
          "string"
        ],
        "active": "boolean",
        "last_error": "null"
      },
      "secret": "string"
    }
  },
  "crm_write_guard_set": {
    "status": "ok",
    "shape": {
      "rejected_origins": [
        "string"
      ],
      "require_origin": "boolean",
      "team_visibility_only_apps": []
    }
  }
}

## Commands

[
  {
    "command": "curl /health",
    "status": "ok",
    "shape": {
      "ok": "boolean",
      "version": "string",
      "db": "string"
    }
  },
  {
    "command": "tools/list",
    "status": "ok",
    "count": 75
  },
  {
    "command": "resources/list+read",
    "status": "ok",
    "count": 5
  },
  {
    "command": "prompts/list",
    "status": "ok",
    "count": 3
  },
  {
    "command": "tools/call all registered",
    "status": "ok",
    "count": 75
  },
  {
    "command": "queue drain",
    "status": "ok",
    "shape": [
      {
        "_count": {
          "_all": 28
        },
        "type": "derived.refresh",
        "status": "completed"
      },
      {
        "_count": {
          "_all": 16
        },
        "type": "list.refresh",
        "status": "completed"
      },
      {
        "_count": {
          "_all": 1
        },
        "type": "match-key-backfill",
        "status": "completed"
      },
      {
        "_count": {
          "_all": 73
        },
        "type": "record.reindex",
        "status": "completed"
      },
      {
        "_count": {
          "_all": 1
        },
        "type": "records.bulk_assert",
        "status": "completed"
      },
      {
        "_count": {
          "_all": 1
        },
        "type": "records.dedup_scan",
        "status": "completed"
      },
      {
        "_count": {
          "_all": 1
        },
        "type": "records.export",
        "status": "completed"
      }
    ]
  },
  {
    "command": "node scripts/verify-audit-chain.mjs",
    "status": "ok",
    "output": ""
  }
]
