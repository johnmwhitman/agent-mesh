/**
 * Additive manual corpus fixtures that are intentionally outside the canonical
 * generator's raw vector list. These entries preserve the discussion-family
 * corpus without letting a partial generator overwrite or delete them.
 *
 * The committed manifest and fixture bytes remain authoritative. The SHA-256
 * pins make byte drift explicit, while the preservation test proves that the
 * canonical raw inventory plus this slice is exactly the committed inventory.
 */

export type CorpusOp = { op: "set" | "delete" | "push"; path: string; value?: unknown };

export type AdditiveCorpusVector = {
  id: string;
  primary: string;
  classification: "caught" | "anomaly" | "undetectable";
  lie: string;
  ops: CorpusOp[];
  expected_ok: boolean;
  expected_findings: Array<{ severity: string; check: string; subject: string }>;
};

export type AdditiveCorpusFixture = {
  vector: AdditiveCorpusVector;
  fixtureSha256: string;
};

export const ADDITIVE_CORPUS_FIXTURES = [
  {
    "vector": {
      "id": "discussion-no-valid-root",
      "primary": "discussion.no_valid_root",
      "classification": "caught",
      "lie": "messages carrying discussion/v1 envelopes exist but none qualifies as a valid root",
      "ops": [
        {
          "op": "set",
          "path": "messages|d-m1",
          "value": {
            "id": "d-m1",
            "from_agent_id": "a1",
            "to_agent_id": "a2",
            "fleet_id": "f1",
            "type": "result",
            "payload": "{\"$meshfleet\":\"discussion/v1\",\"discussion_id\":\"disc-1\",\"turn\":2,\"attempt_id\":\"att-1\",\"reply_to\":\"nonexistent\",\"kind\":\"question\",\"body\":\"hello\",\"close\":false}",
            "correlation_id": "disc-1",
            "timestamp": 1799999999000,
            "acknowledged": false
          }
        }
      ],
      "expected_ok": false,
      "expected_findings": [
        {
          "severity": "error",
          "check": "discussion.derive_invalid",
          "subject": "disc-1"
        },
        {
          "severity": "error",
          "check": "discussion.no_valid_root",
          "subject": "disc-1"
        }
      ]
    },
    "fixtureSha256": "95fab7df0020ea54b940588d28e8ee8a70e07d837fa674cfa5019423ae75dccc"
  },
  {
    "vector": {
      "id": "discussion-duplicate-root",
      "primary": "discussion.duplicate_root",
      "classification": "caught",
      "lie": "two messages both qualify as valid discussion roots for the same correlation id",
      "ops": [
        {
          "op": "set",
          "path": "messages|d-m1",
          "value": {
            "id": "d-m1",
            "from_agent_id": "a1",
            "to_agent_id": "a2",
            "fleet_id": "f1",
            "type": "question",
            "payload": "{\"$meshfleet\":\"discussion/v1\",\"discussion_id\":\"disc-1\",\"turn\":1,\"attempt_id\":\"att-1\",\"reply_to\":null,\"kind\":\"question\",\"body\":\"hello\",\"close\":false,\"policy\":{\"participants\":[\"a1\",\"a2\"],\"max_turns\":4,\"conversation_deadline\":1800000050000,\"turn_timeout_ms\":30000}}",
            "correlation_id": "disc-1",
            "timestamp": 1799999998000,
            "acknowledged": false
          }
        },
        {
          "op": "set",
          "path": "messages|d-m2",
          "value": {
            "id": "d-m2",
            "from_agent_id": "a1",
            "to_agent_id": "a2",
            "fleet_id": "f1",
            "type": "question",
            "payload": "{\"$meshfleet\":\"discussion/v1\",\"discussion_id\":\"disc-1\",\"turn\":1,\"attempt_id\":\"att-1\",\"reply_to\":null,\"kind\":\"question\",\"body\":\"hello\",\"close\":false,\"policy\":{\"participants\":[\"a1\",\"a2\"],\"max_turns\":4,\"conversation_deadline\":1800000050000,\"turn_timeout_ms\":30000}}",
            "correlation_id": "disc-1",
            "timestamp": 1799999998001,
            "acknowledged": false
          }
        }
      ],
      "expected_ok": false,
      "expected_findings": [
        {
          "severity": "error",
          "check": "discussion.derive_invalid",
          "subject": "disc-1"
        },
        {
          "severity": "error",
          "check": "discussion.duplicate_root",
          "subject": "d-m2"
        }
      ]
    },
    "fixtureSha256": "ee18c9bf0d0b8d420d0c23226a54900776c6d974a77493d0d7d68eccfc8f682e"
  },
  {
    "vector": {
      "id": "discussion-child-policy-forbidden",
      "primary": "discussion.child_policy_forbidden",
      "classification": "caught",
      "lie": "a non-root envelope carries a policy block — only the root may define the immutable policy",
      "ops": [
        {
          "op": "set",
          "path": "messages|d-m1",
          "value": {
            "id": "d-m1",
            "from_agent_id": "a1",
            "to_agent_id": "a2",
            "fleet_id": "f1",
            "type": "question",
            "payload": "{\"$meshfleet\":\"discussion/v1\",\"discussion_id\":\"disc-1\",\"turn\":1,\"attempt_id\":\"att-1\",\"reply_to\":null,\"kind\":\"question\",\"body\":\"hello\",\"close\":false,\"policy\":{\"participants\":[\"a1\",\"a2\"],\"max_turns\":4,\"conversation_deadline\":1800000050000,\"turn_timeout_ms\":30000}}",
            "correlation_id": "disc-1",
            "timestamp": 1799999998000,
            "acknowledged": false
          }
        },
        {
          "op": "set",
          "path": "messages|d-m2",
          "value": {
            "id": "d-m2",
            "from_agent_id": "a2",
            "to_agent_id": "a1",
            "fleet_id": "f1",
            "type": "result",
            "payload": "{\"$meshfleet\":\"discussion/v1\",\"discussion_id\":\"disc-1\",\"turn\":2,\"attempt_id\":\"att-2\",\"reply_to\":\"d-m1\",\"kind\":\"result\",\"body\":\"hello\",\"close\":false,\"policy\":{\"participants\":[\"a1\",\"a2\"],\"max_turns\":4,\"conversation_deadline\":1800000050000,\"turn_timeout_ms\":30000}}",
            "correlation_id": "disc-1",
            "timestamp": 1799999999000,
            "acknowledged": false
          }
        }
      ],
      "expected_ok": false,
      "expected_findings": [
        {
          "severity": "error",
          "check": "discussion.child_policy_forbidden",
          "subject": "d-m2"
        },
        {
          "severity": "error",
          "check": "discussion.derive_invalid",
          "subject": "disc-1"
        }
      ]
    },
    "fixtureSha256": "db1a0a72e84f681a8aaa846f902a84ec88c4aa5647be5bf701bf82ef77b4d28e"
  },
  {
    "vector": {
      "id": "discussion-wrong-fleet",
      "primary": "discussion.wrong_fleet",
      "classification": "caught",
      "lie": "a discussion envelope is carried by a message in a different fleet than the root",
      "ops": [
        {
          "op": "set",
          "path": "messages|d-m1",
          "value": {
            "id": "d-m1",
            "from_agent_id": "a1",
            "to_agent_id": "a2",
            "fleet_id": "f1",
            "type": "question",
            "payload": "{\"$meshfleet\":\"discussion/v1\",\"discussion_id\":\"disc-1\",\"turn\":1,\"attempt_id\":\"att-1\",\"reply_to\":null,\"kind\":\"question\",\"body\":\"hello\",\"close\":false,\"policy\":{\"participants\":[\"a1\",\"a2\"],\"max_turns\":4,\"conversation_deadline\":1800000050000,\"turn_timeout_ms\":30000}}",
            "correlation_id": "disc-1",
            "timestamp": 1799999998000,
            "acknowledged": false
          }
        },
        {
          "op": "set",
          "path": "messages|d-m2",
          "value": {
            "id": "d-m2",
            "from_agent_id": "a2",
            "to_agent_id": "a1",
            "fleet_id": "f-other",
            "type": "result",
            "payload": "{\"$meshfleet\":\"discussion/v1\",\"discussion_id\":\"disc-1\",\"turn\":2,\"attempt_id\":\"att-2\",\"reply_to\":\"d-m1\",\"kind\":\"result\",\"body\":\"hello\",\"close\":false}",
            "correlation_id": "disc-1",
            "timestamp": 1799999999000,
            "acknowledged": false
          }
        }
      ],
      "expected_ok": false,
      "expected_findings": [
        {
          "severity": "error",
          "check": "discussion.derive_invalid",
          "subject": "disc-1"
        },
        {
          "severity": "error",
          "check": "discussion.wrong_fleet",
          "subject": "d-m2"
        },
        {
          "severity": "warning",
          "check": "message.orphan_fleet",
          "subject": "d-m2"
        }
      ]
    },
    "fixtureSha256": "26bf000c1b9d3c7e47e7e9ce84ea3b8f8a6e698c47ea3ce6f2b9c51403f55b4b"
  },
  {
    "vector": {
      "id": "discussion-participant-violation",
      "primary": "discussion.participant_violation",
      "classification": "caught",
      "lie": "a discussion message involves an agent not in the policy's two-participant set",
      "ops": [
        {
          "op": "set",
          "path": "messages|d-m1",
          "value": {
            "id": "d-m1",
            "from_agent_id": "a1",
            "to_agent_id": "a2",
            "fleet_id": "f1",
            "type": "question",
            "payload": "{\"$meshfleet\":\"discussion/v1\",\"discussion_id\":\"disc-1\",\"turn\":1,\"attempt_id\":\"att-1\",\"reply_to\":null,\"kind\":\"question\",\"body\":\"hello\",\"close\":false,\"policy\":{\"participants\":[\"a1\",\"a2\"],\"max_turns\":4,\"conversation_deadline\":1800000050000,\"turn_timeout_ms\":30000}}",
            "correlation_id": "disc-1",
            "timestamp": 1799999998000,
            "acknowledged": false
          }
        },
        {
          "op": "set",
          "path": "messages|d-m2",
          "value": {
            "id": "d-m2",
            "from_agent_id": "a3",
            "to_agent_id": "a1",
            "fleet_id": "f1",
            "type": "result",
            "payload": "{\"$meshfleet\":\"discussion/v1\",\"discussion_id\":\"disc-1\",\"turn\":2,\"attempt_id\":\"att-2\",\"reply_to\":\"d-m1\",\"kind\":\"result\",\"body\":\"hello\",\"close\":false}",
            "correlation_id": "disc-1",
            "timestamp": 1799999999000,
            "acknowledged": false
          }
        }
      ],
      "expected_ok": false,
      "expected_findings": [
        {
          "severity": "error",
          "check": "discussion.derive_invalid",
          "subject": "disc-1"
        },
        {
          "severity": "error",
          "check": "discussion.participant_violation",
          "subject": "d-m2"
        }
      ]
    },
    "fixtureSha256": "5aa2148c8d94c40780792ee145803c30248bbc04b1a9acfc63c61c8438a325ad"
  },
  {
    "vector": {
      "id": "discussion-kind-type-mismatch",
      "primary": "discussion.kind_type_mismatch",
      "classification": "caught",
      "lie": "the envelope kind disagrees with the message type",
      "ops": [
        {
          "op": "set",
          "path": "messages|d-m1",
          "value": {
            "id": "d-m1",
            "from_agent_id": "a1",
            "to_agent_id": "a2",
            "fleet_id": "f1",
            "type": "question",
            "payload": "{\"$meshfleet\":\"discussion/v1\",\"discussion_id\":\"disc-1\",\"turn\":1,\"attempt_id\":\"att-1\",\"reply_to\":null,\"kind\":\"question\",\"body\":\"hello\",\"close\":false,\"policy\":{\"participants\":[\"a1\",\"a2\"],\"max_turns\":4,\"conversation_deadline\":1800000050000,\"turn_timeout_ms\":30000}}",
            "correlation_id": "disc-1",
            "timestamp": 1799999998000,
            "acknowledged": false
          }
        },
        {
          "op": "set",
          "path": "messages|d-m2",
          "value": {
            "id": "d-m2",
            "from_agent_id": "a2",
            "to_agent_id": "a1",
            "fleet_id": "f1",
            "type": "result",
            "payload": "{\"$meshfleet\":\"discussion/v1\",\"discussion_id\":\"disc-1\",\"turn\":2,\"attempt_id\":\"att-2\",\"reply_to\":\"d-m1\",\"kind\":\"question\",\"body\":\"hello\",\"close\":false}",
            "correlation_id": "disc-1",
            "timestamp": 1799999999000,
            "acknowledged": false
          }
        }
      ],
      "expected_ok": false,
      "expected_findings": [
        {
          "severity": "error",
          "check": "discussion.derive_invalid",
          "subject": "disc-1"
        },
        {
          "severity": "error",
          "check": "discussion.kind_type_mismatch",
          "subject": "d-m2"
        }
      ]
    },
    "fixtureSha256": "da79aca91d06cdbc1422075a153d19766aebbee0131770758c0e361c9ad038e1"
  },
  {
    "vector": {
      "id": "discussion-broadcast-forbidden",
      "primary": "discussion.broadcast_forbidden",
      "classification": "caught",
      "lie": "a discussion/v1 envelope is smuggled via a broadcast message",
      "ops": [
        {
          "op": "set",
          "path": "messages|d-m1",
          "value": {
            "id": "d-m1",
            "from_agent_id": "a1",
            "to_agent_id": "*",
            "fleet_id": "f1",
            "type": "question",
            "payload": "{\"$meshfleet\":\"discussion/v1\",\"discussion_id\":\"disc-1\",\"turn\":1,\"attempt_id\":\"att-1\",\"reply_to\":null,\"kind\":\"question\",\"body\":\"hello\",\"close\":false,\"policy\":{\"participants\":[\"a1\",\"a2\"],\"max_turns\":4,\"conversation_deadline\":1800000050000,\"turn_timeout_ms\":30000}}",
            "correlation_id": "disc-1",
            "timestamp": 1799999999000,
            "acknowledged": false
          }
        }
      ],
      "expected_ok": false,
      "expected_findings": [
        {
          "severity": "error",
          "check": "discussion.broadcast_forbidden",
          "subject": "d-m1"
        },
        {
          "severity": "error",
          "check": "discussion.derive_invalid",
          "subject": "disc-1"
        },
        {
          "severity": "error",
          "check": "discussion.no_valid_root",
          "subject": "disc-1"
        }
      ]
    },
    "fixtureSha256": "9cf69dafeaad6dfc2d07cbc41b0707d968a4253d1a06b35b86382a281bba13ae"
  },
  {
    "vector": {
      "id": "discussion-invalid-sender",
      "primary": "discussion.invalid_sender",
      "classification": "caught",
      "lie": "a reply does not alternate sender and recipient",
      "ops": [
        {
          "op": "set",
          "path": "messages|d-m1",
          "value": {
            "id": "d-m1",
            "from_agent_id": "a1",
            "to_agent_id": "a2",
            "fleet_id": "f1",
            "type": "question",
            "payload": "{\"$meshfleet\":\"discussion/v1\",\"discussion_id\":\"disc-1\",\"turn\":1,\"attempt_id\":\"att-1\",\"reply_to\":null,\"kind\":\"question\",\"body\":\"hello\",\"close\":false,\"policy\":{\"participants\":[\"a1\",\"a2\"],\"max_turns\":4,\"conversation_deadline\":1800000050000,\"turn_timeout_ms\":30000}}",
            "correlation_id": "disc-1",
            "timestamp": 1799999998000,
            "acknowledged": false
          }
        },
        {
          "op": "set",
          "path": "messages|d-m2",
          "value": {
            "id": "d-m2",
            "from_agent_id": "a1",
            "to_agent_id": "a2",
            "fleet_id": "f1",
            "type": "result",
            "payload": "{\"$meshfleet\":\"discussion/v1\",\"discussion_id\":\"disc-1\",\"turn\":2,\"attempt_id\":\"att-2\",\"reply_to\":\"d-m1\",\"kind\":\"result\",\"body\":\"hello\",\"close\":false}",
            "correlation_id": "disc-1",
            "timestamp": 1799999999200,
            "acknowledged": false
          }
        },
        {
          "op": "set",
          "path": "receipts|d-m1:a2:discussion.wake.reserved.v1:2:att-2",
          "value": {
            "id": "d-m1:a2:discussion.wake.reserved.v1:2:att-2",
            "agent_id": "a2",
            "message_id": "d-m1",
            "action": "discussion.wake.reserved.v1:2:att-2",
            "note": "{\"discussion_id\":\"disc-1\",\"head_message_id\":\"d-m1\",\"deadline\":1800000030000}",
            "timestamp": 1799999999000
          }
        },
        {
          "op": "set",
          "path": "receipts|d-m1:a2:discussion.wake.completed.v1:2:att-2",
          "value": {
            "id": "d-m1:a2:discussion.wake.completed.v1:2:att-2",
            "agent_id": "a2",
            "message_id": "d-m1",
            "action": "discussion.wake.completed.v1:2:att-2",
            "note": "{\"discussion_id\":\"disc-1\",\"head_message_id\":\"d-m1\",\"deadline\":1800000030000,\"reply_message_id\":\"d-m2\"}",
            "timestamp": 1799999999200
          }
        }
      ],
      "expected_ok": false,
      "expected_findings": [
        {
          "severity": "error",
          "check": "discussion.derive_invalid",
          "subject": "disc-1"
        },
        {
          "severity": "error",
          "check": "discussion.invalid_sender",
          "subject": "d-m2"
        }
      ]
    },
    "fixtureSha256": "c21da15858caaaea2e95162b47978d2e99cef35b39c5653aeace780cea8564b8"
  },
  {
    "vector": {
      "id": "discussion-attempt-identity-conflict",
      "primary": "discussion.attempt_identity_conflict",
      "classification": "caught",
      "lie": "receipts within a single attempt lifecycle disagree on an immutable field",
      "ops": [
        {
          "op": "set",
          "path": "messages|d-m1",
          "value": {
            "id": "d-m1",
            "from_agent_id": "a1",
            "to_agent_id": "a2",
            "fleet_id": "f1",
            "type": "question",
            "payload": "{\"$meshfleet\":\"discussion/v1\",\"discussion_id\":\"disc-1\",\"turn\":1,\"attempt_id\":\"att-1\",\"reply_to\":null,\"kind\":\"question\",\"body\":\"hello\",\"close\":false,\"policy\":{\"participants\":[\"a1\",\"a2\"],\"max_turns\":4,\"conversation_deadline\":1800000050000,\"turn_timeout_ms\":30000}}",
            "correlation_id": "disc-1",
            "timestamp": 1799999998000,
            "acknowledged": false
          }
        },
        {
          "op": "set",
          "path": "receipts|d-m1:a2:discussion.wake.reserved.v1:2:att-2",
          "value": {
            "id": "d-m1:a2:discussion.wake.reserved.v1:2:att-2",
            "agent_id": "a2",
            "message_id": "d-m1",
            "action": "discussion.wake.reserved.v1:2:att-2",
            "note": "{\"discussion_id\":\"disc-1\",\"head_message_id\":\"d-m1\",\"deadline\":1800000030000}",
            "timestamp": 1799999999000
          }
        },
        {
          "op": "set",
          "path": "receipts|d-m1:a2:discussion.wake.started.v1:2:att-2",
          "value": {
            "id": "d-m1:a2:discussion.wake.started.v1:2:att-2",
            "agent_id": "a2",
            "message_id": "d-m1",
            "action": "discussion.wake.started.v1:2:att-2",
            "note": "{\"discussion_id\":\"disc-1\",\"head_message_id\":\"d-m1\",\"deadline\":1800000025000}",
            "timestamp": 1799999999100
          }
        }
      ],
      "expected_ok": false,
      "expected_findings": [
        {
          "severity": "error",
          "check": "discussion.attempt_identity_conflict",
          "subject": "d-m1"
        },
        {
          "severity": "warning",
          "check": "discussion.budget_turns_mismatch",
          "subject": "disc-1"
        },
        {
          "severity": "error",
          "check": "discussion.derive_invalid",
          "subject": "disc-1"
        }
      ]
    },
    "fixtureSha256": "661b3dd9e7c091bd050a1b1e57c682efbe8269ee90da26d866455fa31b523174"
  },
  {
    "vector": {
      "id": "discussion-duplicate-turn",
      "primary": "discussion.duplicate_turn",
      "classification": "caught",
      "lie": "two distinct attempt ids both reserve the same turn number at the same head",
      "ops": [
        {
          "op": "set",
          "path": "messages|d-m1",
          "value": {
            "id": "d-m1",
            "from_agent_id": "a1",
            "to_agent_id": "a2",
            "fleet_id": "f1",
            "type": "question",
            "payload": "{\"$meshfleet\":\"discussion/v1\",\"discussion_id\":\"disc-1\",\"turn\":1,\"attempt_id\":\"att-1\",\"reply_to\":null,\"kind\":\"question\",\"body\":\"hello\",\"close\":false,\"policy\":{\"participants\":[\"a1\",\"a2\"],\"max_turns\":4,\"conversation_deadline\":1800000050000,\"turn_timeout_ms\":30000}}",
            "correlation_id": "disc-1",
            "timestamp": 1799999998000,
            "acknowledged": false
          }
        },
        {
          "op": "set",
          "path": "receipts|d-m1:a2:discussion.wake.reserved.v1:2:att-A",
          "value": {
            "id": "d-m1:a2:discussion.wake.reserved.v1:2:att-A",
            "agent_id": "a2",
            "message_id": "d-m1",
            "action": "discussion.wake.reserved.v1:2:att-A",
            "note": "{\"discussion_id\":\"disc-1\",\"head_message_id\":\"d-m1\",\"deadline\":1800000030000}",
            "timestamp": 1799999999000
          }
        },
        {
          "op": "set",
          "path": "receipts|d-m1:a2:discussion.wake.reserved.v1:2:att-B",
          "value": {
            "id": "d-m1:a2:discussion.wake.reserved.v1:2:att-B",
            "agent_id": "a2",
            "message_id": "d-m1",
            "action": "discussion.wake.reserved.v1:2:att-B",
            "note": "{\"discussion_id\":\"disc-1\",\"head_message_id\":\"d-m1\",\"deadline\":1800000030000}",
            "timestamp": 1799999999001
          }
        }
      ],
      "expected_ok": false,
      "expected_findings": [
        {
          "severity": "warning",
          "check": "discussion.budget_turns_mismatch",
          "subject": "disc-1"
        },
        {
          "severity": "error",
          "check": "discussion.derive_invalid",
          "subject": "disc-1"
        },
        {
          "severity": "error",
          "check": "discussion.duplicate_turn",
          "subject": "d-m1"
        },
        {
          "severity": "error",
          "check": "discussion.duplicate_turn",
          "subject": "d-m1"
        },
        {
          "severity": "warning",
          "check": "discussion.receipt_on_invalid_head",
          "subject": "d-m1"
        }
      ]
    },
    "fixtureSha256": "26795ce85a9005f1dc71fd6d21e38beffa2706112f6e39b403637ebc80ecb02a"
  },
  {
    "vector": {
      "id": "discussion-fork",
      "primary": "discussion.fork",
      "classification": "caught",
      "lie": "two authorized replies target the same head — the discussion chain forks",
      "ops": [
        {
          "op": "set",
          "path": "messages|d-m1",
          "value": {
            "id": "d-m1",
            "from_agent_id": "a1",
            "to_agent_id": "a2",
            "fleet_id": "f1",
            "type": "question",
            "payload": "{\"$meshfleet\":\"discussion/v1\",\"discussion_id\":\"disc-1\",\"turn\":1,\"attempt_id\":\"att-1\",\"reply_to\":null,\"kind\":\"question\",\"body\":\"hello\",\"close\":false,\"policy\":{\"participants\":[\"a1\",\"a2\"],\"max_turns\":4,\"conversation_deadline\":1800000050000,\"turn_timeout_ms\":30000}}",
            "correlation_id": "disc-1",
            "timestamp": 1799999998000,
            "acknowledged": false
          }
        },
        {
          "op": "set",
          "path": "messages|d-m2a",
          "value": {
            "id": "d-m2a",
            "from_agent_id": "a2",
            "to_agent_id": "a1",
            "fleet_id": "f1",
            "type": "result",
            "payload": "{\"$meshfleet\":\"discussion/v1\",\"discussion_id\":\"disc-1\",\"turn\":2,\"attempt_id\":\"att-2a\",\"reply_to\":\"d-m1\",\"kind\":\"result\",\"body\":\"hello\",\"close\":false}",
            "correlation_id": "disc-1",
            "timestamp": 1799999999200,
            "acknowledged": false
          }
        },
        {
          "op": "set",
          "path": "messages|d-m2b",
          "value": {
            "id": "d-m2b",
            "from_agent_id": "a2",
            "to_agent_id": "a1",
            "fleet_id": "f1",
            "type": "result",
            "payload": "{\"$meshfleet\":\"discussion/v1\",\"discussion_id\":\"disc-1\",\"turn\":2,\"attempt_id\":\"att-2b\",\"reply_to\":\"d-m1\",\"kind\":\"result\",\"body\":\"hello\",\"close\":false}",
            "correlation_id": "disc-1",
            "timestamp": 1799999999201,
            "acknowledged": false
          }
        },
        {
          "op": "set",
          "path": "receipts|d-m1:a2:discussion.wake.reserved.v1:2:att-2a",
          "value": {
            "id": "d-m1:a2:discussion.wake.reserved.v1:2:att-2a",
            "agent_id": "a2",
            "message_id": "d-m1",
            "action": "discussion.wake.reserved.v1:2:att-2a",
            "note": "{\"discussion_id\":\"disc-1\",\"head_message_id\":\"d-m1\",\"deadline\":1800000030000}",
            "timestamp": 1799999999000
          }
        },
        {
          "op": "set",
          "path": "receipts|d-m1:a2:discussion.wake.completed.v1:2:att-2a",
          "value": {
            "id": "d-m1:a2:discussion.wake.completed.v1:2:att-2a",
            "agent_id": "a2",
            "message_id": "d-m1",
            "action": "discussion.wake.completed.v1:2:att-2a",
            "note": "{\"discussion_id\":\"disc-1\",\"head_message_id\":\"d-m1\",\"deadline\":1800000030000,\"reply_message_id\":\"d-m2a\"}",
            "timestamp": 1799999999200
          }
        },
        {
          "op": "set",
          "path": "receipts|d-m1:a2:discussion.wake.reserved.v1:2:att-2b",
          "value": {
            "id": "d-m1:a2:discussion.wake.reserved.v1:2:att-2b",
            "agent_id": "a2",
            "message_id": "d-m1",
            "action": "discussion.wake.reserved.v1:2:att-2b",
            "note": "{\"discussion_id\":\"disc-1\",\"head_message_id\":\"d-m1\",\"deadline\":1800000030000}",
            "timestamp": 1799999999001
          }
        },
        {
          "op": "set",
          "path": "receipts|d-m1:a2:discussion.wake.completed.v1:2:att-2b",
          "value": {
            "id": "d-m1:a2:discussion.wake.completed.v1:2:att-2b",
            "agent_id": "a2",
            "message_id": "d-m1",
            "action": "discussion.wake.completed.v1:2:att-2b",
            "note": "{\"discussion_id\":\"disc-1\",\"head_message_id\":\"d-m1\",\"deadline\":1800000030000,\"reply_message_id\":\"d-m2b\"}",
            "timestamp": 1799999999201
          }
        }
      ],
      "expected_ok": false,
      "expected_findings": [
        {
          "severity": "warning",
          "check": "discussion.budget_turns_mismatch",
          "subject": "disc-1"
        },
        {
          "severity": "error",
          "check": "discussion.derive_invalid",
          "subject": "disc-1"
        },
        {
          "severity": "error",
          "check": "discussion.duplicate_turn",
          "subject": "d-m1"
        },
        {
          "severity": "error",
          "check": "discussion.duplicate_turn",
          "subject": "d-m1"
        },
        {
          "severity": "error",
          "check": "discussion.fork",
          "subject": "d-m2a"
        },
        {
          "severity": "error",
          "check": "discussion.fork",
          "subject": "d-m2b"
        },
        {
          "severity": "warning",
          "check": "discussion.receipt_on_invalid_head",
          "subject": "d-m1"
        },
        {
          "severity": "warning",
          "check": "discussion.receipt_on_invalid_head",
          "subject": "d-m1"
        }
      ]
    },
    "fixtureSha256": "96296214d59634a8a2c2ffe24b84c8304ec6da167e38414e94d67dd9caa49eb4"
  },
  {
    "vector": {
      "id": "discussion-ordinal-discontinuity",
      "primary": "discussion.ordinal_discontinuity",
      "classification": "caught",
      "lie": "a reply claims a turn that skips over unreserved turns",
      "ops": [
        {
          "op": "set",
          "path": "messages|d-m1",
          "value": {
            "id": "d-m1",
            "from_agent_id": "a1",
            "to_agent_id": "a2",
            "fleet_id": "f1",
            "type": "question",
            "payload": "{\"$meshfleet\":\"discussion/v1\",\"discussion_id\":\"disc-1\",\"turn\":1,\"attempt_id\":\"att-1\",\"reply_to\":null,\"kind\":\"question\",\"body\":\"hello\",\"close\":false,\"policy\":{\"participants\":[\"a1\",\"a2\"],\"max_turns\":4,\"conversation_deadline\":1800000050000,\"turn_timeout_ms\":30000}}",
            "correlation_id": "disc-1",
            "timestamp": 1799999998000,
            "acknowledged": false
          }
        },
        {
          "op": "set",
          "path": "messages|d-m3",
          "value": {
            "id": "d-m3",
            "from_agent_id": "a2",
            "to_agent_id": "a1",
            "fleet_id": "f1",
            "type": "result",
            "payload": "{\"$meshfleet\":\"discussion/v1\",\"discussion_id\":\"disc-1\",\"turn\":3,\"attempt_id\":\"att-3\",\"reply_to\":\"d-m1\",\"kind\":\"result\",\"body\":\"hello\",\"close\":false}",
            "correlation_id": "disc-1",
            "timestamp": 1799999999200,
            "acknowledged": false
          }
        },
        {
          "op": "set",
          "path": "receipts|d-m1:a2:discussion.wake.reserved.v1:3:att-3",
          "value": {
            "id": "d-m1:a2:discussion.wake.reserved.v1:3:att-3",
            "agent_id": "a2",
            "message_id": "d-m1",
            "action": "discussion.wake.reserved.v1:3:att-3",
            "note": "{\"discussion_id\":\"disc-1\",\"head_message_id\":\"d-m1\",\"deadline\":1800000030000}",
            "timestamp": 1799999999000
          }
        },
        {
          "op": "set",
          "path": "receipts|d-m1:a2:discussion.wake.completed.v1:3:att-3",
          "value": {
            "id": "d-m1:a2:discussion.wake.completed.v1:3:att-3",
            "agent_id": "a2",
            "message_id": "d-m1",
            "action": "discussion.wake.completed.v1:3:att-3",
            "note": "{\"discussion_id\":\"disc-1\",\"head_message_id\":\"d-m1\",\"deadline\":1800000030000,\"reply_message_id\":\"d-m3\"}",
            "timestamp": 1799999999200
          }
        }
      ],
      "expected_ok": false,
      "expected_findings": [
        {
          "severity": "warning",
          "check": "discussion.budget_turns_mismatch",
          "subject": "disc-1"
        },
        {
          "severity": "error",
          "check": "discussion.derive_invalid",
          "subject": "disc-1"
        },
        {
          "severity": "error",
          "check": "discussion.ordinal_discontinuity",
          "subject": "d-m1"
        },
        {
          "severity": "error",
          "check": "discussion.ordinal_discontinuity",
          "subject": "disc-1"
        }
      ]
    },
    "fixtureSha256": "22ee25480dd6365ebf4603fb2e6f01318ac984dba840b1b132ab57f4064a38bd"
  }
] as const satisfies readonly AdditiveCorpusFixture[];
