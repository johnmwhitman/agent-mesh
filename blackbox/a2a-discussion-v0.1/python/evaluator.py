import json
import re
import math

MAX_PAYLOAD_BYTES = 65536
MIN_MAX_TURNS = 2
MAX_MAX_TURNS = 32
MIN_TURN_TIMEOUT_MS = 1000
MAX_TURN_TIMEOUT_MS = 300000
BROADCAST = '*'

WAKE_STATES = ('reserved', 'started', 'completed', 'failed', 'deadman')
TERMINAL_STATES = ('completed', 'failed', 'deadman')

RANK = {'reserved': 0, 'started': 1, 'completed': 2, 'failed': 2, 'deadman': 2}


def _is_non_empty_string(v):
    return isinstance(v, str) and len(v) > 0


def _is_finite_number(v):
    if isinstance(v, bool):
        return False
    return isinstance(v, (int, float)) and math.isfinite(v)


def _is_policy_shape(p):
    if not isinstance(p, dict):
        return False
    participants = p.get('participants')
    if not isinstance(participants, list) or len(participants) != 2:
        return False
    a, b = participants
    if not _is_non_empty_string(a) or not _is_non_empty_string(b) or a == b:
        return False
    max_turns = p.get('max_turns')
    if isinstance(max_turns, bool) or not isinstance(max_turns, int):
        return False
    if max_turns < MIN_MAX_TURNS or max_turns > MAX_MAX_TURNS:
        return False
    conv_deadline = p.get('conversation_deadline')
    if not _is_finite_number(conv_deadline):
        return False
    turn_timeout = p.get('turn_timeout_ms')
    if isinstance(turn_timeout, bool) or not isinstance(turn_timeout, int):
        return False
    if turn_timeout < MIN_TURN_TIMEOUT_MS or turn_timeout > MAX_TURN_TIMEOUT_MS:
        return False
    return True


def _validate_payload_size(payload):
    if not isinstance(payload, str):
        return False
    return len(payload.encode('utf-8')) <= MAX_PAYLOAD_BYTES


def parse_envelope(payload):
    if not isinstance(payload, str):
        return None
    try:
        parsed = json.loads(payload)
    except (json.JSONDecodeError, TypeError):
        return None
    if not isinstance(parsed, dict):
        return None
    e = parsed
    if not _is_non_empty_string(e.get('$meshfleet')):
        return None
    if not _is_non_empty_string(e.get('discussion_id')):
        return None
    turn = e.get('turn')
    if isinstance(turn, bool) or not isinstance(turn, int) or turn < 1:
        return None
    if not _is_non_empty_string(e.get('attempt_id')):
        return None
    if 'reply_to' not in e:
        return None
    reply_to = e.get('reply_to')
    if reply_to is not None and not _is_non_empty_string(reply_to):
        return None
    kind = e.get('kind')
    if kind not in ('question', 'result'):
        return None
    body = e.get('body')
    if not isinstance(body, str):
        return None
    close = e.get('close')
    if not isinstance(close, bool):
        return None
    policy = e.get('policy')
    if policy is not None and not _is_policy_shape(policy):
        return None
    result = {
        '$meshfleet': e['$meshfleet'],
        'discussion_id': e['discussion_id'],
        'turn': turn,
        'attempt_id': e['attempt_id'],
        'reply_to': reply_to,
        'kind': kind,
        'body': body,
        'close': close,
    }
    if policy is not None:
        result['policy'] = policy
    return result


parseEnvelope = parse_envelope


def _is_broadcast_message(message):
    if message.get('to_agent_id') == BROADCAST:
        return True
    if 'recipients' in message:
        return True
    return False


def _validate_envelope(envelope, message):
    if envelope is None:
        return {'valid': False, 'reason': 'invalid_envelope'}
    if not _validate_payload_size(message.get('payload', '')):
        return {'valid': False, 'reason': 'payload_too_large'}
    if envelope.get('$meshfleet') != 'discussion/v1':
        return {'valid': False, 'reason': 'invalid_version'}
    if _is_broadcast_message(message):
        return {'valid': False, 'reason': 'broadcast_forbidden'}
    if message.get('correlation_id') != envelope.get('discussion_id'):
        return {'valid': False, 'reason': 'correlation_mismatch'}
    if envelope.get('kind') not in ('question', 'result'):
        return {'valid': False, 'reason': 'invalid_kind'}
    return {'valid': True}


def looks_like_discussion_action(action):
    return isinstance(action, str) and action.startswith('discussion.')


def parse_receipt_action(action):
    if not isinstance(action, str):
        return None
    colon_parts = action.split(':')
    if len(colon_parts) != 3:
        return None
    name, turn_str, attempt_id = colon_parts
    if not re.match(r'^\d+$', turn_str):
        return None
    turn = int(turn_str)
    if turn < 1:
        return None
    if not _is_non_empty_string(attempt_id):
        return None
    name_parts = name.split('.')
    if len(name_parts) != 4:
        return None
    namespace, event, state, version = name_parts
    if namespace != 'discussion':
        return None
    if version != 'v1':
        return None
    if event == 'wake' and state in WAKE_STATES:
        return {'kind': 'wake', 'state': state, 'turn': turn, 'attempt_id': attempt_id}
    if event == 'turn' and state == 'sent':
        return {'kind': 'turn_sent', 'turn': turn, 'attempt_id': attempt_id}
    return None


parseReceiptAction = parse_receipt_action


def _validate_wake_receipt_note(receipt, parsed, discussion_id):
    note_str = receipt.get('note')
    if note_str is None:
        return {'ok': False, 'reason': 'missing_note'}
    try:
        raw = json.loads(note_str)
    except (json.JSONDecodeError, TypeError):
        return {'ok': False, 'reason': 'note_not_json'}
    if not isinstance(raw, dict):
        return {'ok': False, 'reason': 'note_not_object'}
    n = raw
    if n.get('discussion_id') != discussion_id:
        return {'ok': False, 'reason': 'note_discussion_mismatch'}
    if n.get('head_message_id') != receipt.get('message_id'):
        return {'ok': False, 'reason': 'note_head_mismatch'}
    if not _is_finite_number(n.get('deadline')):
        return {'ok': False, 'reason': 'note_deadline_invalid'}
    if parsed['state'] == 'completed':
        if not _is_non_empty_string(n.get('reply_message_id')):
            return {'ok': False, 'reason': 'note_missing_reply'}
    if 'reply_message_id' in n and not _is_non_empty_string(n.get('reply_message_id')):
        return {'ok': False, 'reason': 'note_reply_invalid'}
    result = {
        'discussion_id': n['discussion_id'],
        'head_message_id': n['head_message_id'],
        'deadline': n['deadline'],
    }
    if 'reply_message_id' in n:
        result['reply_message_id'] = n['reply_message_id']
    return {'ok': True, 'note': result}


def _recompute_status(invalid, transcript, root_message_id, attempts, policy, now, turns_used):
    live_attempts = [a for a in attempts if a['state'] in ('reserved', 'started')]
    if invalid or len(live_attempts) > 1:
        return 'invalid'
    for entry in transcript:
        if entry['message']['id'] == root_message_id:
            continue
        envelope = parse_envelope(entry['message'].get('payload', ''))
        if envelope is not None and envelope['close'] is True:
            return 'closed'
    sole_live = live_attempts[0] if live_attempts else None
    if any(a['state'] == 'deadman' for a in attempts):
        return 'deadman'
    if sole_live is not None and sole_live['deadline'] <= now:
        return 'deadman'
    if now > policy['conversation_deadline']:
        return 'expired'
    if turns_used >= policy['max_turns']:
        return 'exhausted'
    if sole_live is not None and sole_live['deadline'] > now:
        return 'active'
    return 'open'


def derive_discussion(discussion_id, messages, receipts, now=0):
    findings = []
    discussion_invalid = False
    explained = set()

    def note(finding):
        findings.append(finding)
        mid = finding.get('message_id')
        if mid:
            explained.add(mid)

    # STEP 1
    correlated = [m for m in messages if m.get('correlation_id') == discussion_id]
    correlated_ids = {m['id'] for m in correlated}

    # STEP 2
    valid = {}
    for msg in correlated:
        envelope = parse_envelope(msg.get('payload', ''))
        validation = _validate_envelope(envelope, msg)
        if not validation['valid'] or envelope is None:
            note({
                'code': validation.get('reason') or 'invalid_envelope',
                'message_id': msg['id'],
                'detail': f"Envelope validation failed: {validation.get('reason') or 'invalid_envelope'}",
            })
            continue
        if envelope['turn'] != 1 and 'policy' in envelope:
            discussion_invalid = True
            note({
                'code': 'child_policy_forbidden',
                'message_id': msg['id'],
                'detail': 'Only the root envelope may carry a policy block',
            })
            continue
        valid[msg['id']] = {'envelope': envelope, 'message': msg}

    # STEP 3
    root_candidates = []
    for candidate in valid.values():
        envelope = candidate['envelope']
        message = candidate['message']
        if envelope['turn'] != 1 or envelope['reply_to'] is not None:
            continue
        if message.get('type') != 'question' or envelope['kind'] != 'question':
            note({
                'code': 'root_not_question',
                'message_id': message['id'],
                'detail': f"Root must be message.type='question' and envelope.kind='question'; got type='{message.get('type')}', kind='{envelope['kind']}'",
            })
            continue
        if 'policy' not in envelope:
            note({
                'code': 'root_missing_policy',
                'message_id': message['id'],
                'detail': 'Root envelope is missing the immutable policy block',
            })
            continue
        p1, p2 = envelope['policy']['participants']
        if message.get('from_agent_id') != p1 or message.get('to_agent_id') != p2:
            note({
                'code': 'root_participant_mismatch',
                'message_id': message['id'],
                'detail': f"Root participants {p1},{p2} do not match message {message.get('from_agent_id')},{message.get('to_agent_id')}",
            })
            continue
        root_candidates.append(candidate)

    if len(root_candidates) == 0:
        findings.append({'code': 'no_valid_root', 'detail': 'No valid discussion/v1 root found for this discussion id'})
        return {
            'status': 'invalid',
            'turns_used': 0,
            'turns_remaining': 0,
            'transcript': [],
            'attempts': [],
            'integrity_findings': findings,
        }
    if len(root_candidates) > 1:
        for extra in root_candidates[1:]:
            note({
                'code': 'duplicate_root',
                'message_id': extra['message']['id'],
                'detail': 'A second valid root was found for this discussion id',
            })
        return {
            'status': 'invalid',
            'turns_used': 0,
            'turns_remaining': 0,
            'transcript': [],
            'attempts': [],
            'integrity_findings': findings,
        }

    root = root_candidates[0]
    policy = root['envelope']['policy']
    explained.add(root['message']['id'])

    if root['envelope']['close'] is True:
        note({
            'code': 'root_close_forbidden',
            'message_id': root['message']['id'],
            'detail': "The root envelope must not set close=true; closing only takes effect via an authorized reply",
        })

    # Global structural pass
    participant_set = set(policy['participants'])
    globally_valid = set()
    for msg_id, candidate in valid.items():
        if msg_id == root['message']['id']:
            continue
        envelope = candidate['envelope']
        message = candidate['message']
        is_root_shaped = envelope['turn'] == 1 and envelope['reply_to'] is None
        ok = True
        if message.get('fleet_id') != root['message'].get('fleet_id'):
            discussion_invalid = True
            note({
                'code': 'wrong_fleet',
                'message_id': msg_id,
                'detail': f"Fleet mismatch: message fleet '{message.get('fleet_id')}' != root fleet '{root['message'].get('fleet_id')}'",
            })
            ok = False
        from_id = message.get('from_agent_id')
        to_id = message.get('to_agent_id')
        if from_id not in participant_set or to_id not in participant_set or from_id == to_id:
            discussion_invalid = True
            note({
                'code': 'participant_violation',
                'message_id': msg_id,
                'detail': f"Sender/recipient {from_id}->{to_id} are not the discussion's two participants",
            })
            ok = False
        if not is_root_shaped and message.get('type') != envelope['kind']:
            discussion_invalid = True
            note({
                'code': 'kind_type_mismatch',
                'message_id': msg_id,
                'detail': f"Envelope kind '{envelope['kind']}' does not match message type '{message.get('type')}'",
            })
            ok = False
        if ok and not is_root_shaped:
            globally_valid.add(msg_id)

    # Receipts pass
    wake_receipts_by_attempt = {}
    for receipt in receipts:
        mid = receipt.get('message_id')
        if mid not in correlated_ids:
            continue
        if not looks_like_discussion_action(receipt.get('action', '')):
            continue
        parsed = parse_receipt_action(receipt['action'])
        if parsed is None:
            note({
                'code': 'unmatched_receipt',
                'message_id': mid,
                'detail': f"Receipt action '{receipt['action']}' does not match a known discussion lifecycle format",
            })
            continue
        if parsed['kind'] == 'turn_sent':
            root_attempt_id = root['envelope']['attempt_id']
            if parsed['turn'] != 1 or parsed['attempt_id'] != root_attempt_id:
                note({
                    'code': 'unmatched_receipt',
                    'message_id': mid,
                    'detail': 'discussion.turn.sent receipt does not match the root attempt',
                })
            continue
        validated = _validate_wake_receipt_note(receipt, parsed, discussion_id)
        if not validated['ok']:
            note({
                'code': 'malformed_receipt_note',
                'message_id': mid,
                'detail': f"Wake receipt note failed validation: {validated['reason']}",
            })
            continue
        attempt_id = parsed['attempt_id']
        if attempt_id not in wake_receipts_by_attempt:
            wake_receipts_by_attempt[attempt_id] = []
        wake_receipts_by_attempt[attempt_id].append({
            'receipt': receipt,
            'parsed': parsed,
            'note': validated['note'],
        })

    # Build validated attempts
    valid_attempts = {}
    for attempt_id, group in wake_receipts_by_attempt.items():
        if not any(g['parsed']['state'] == 'reserved' for g in group):
            note({
                'code': 'attempt_missing_reservation',
                'message_id': group[0]['receipt']['message_id'],
                'detail': f"Attempt '{attempt_id}' has no 'reserved' receipt in its lifecycle and cannot be validated",
            })
            continue

        first = group[0]
        head_id = first['note']['head_message_id']
        turn = first['parsed']['turn']
        agent_id = first['receipt']['agent_id']
        deadline = first['note']['deadline']

        consistent = True
        completed_reply_ids = set()
        for entry in group:
            if (entry['note']['head_message_id'] != head_id or
                entry['parsed']['turn'] != turn or
                entry['receipt']['agent_id'] != agent_id or
                entry['note']['deadline'] != deadline):
                consistent = False
            if entry['parsed']['state'] == 'completed':
                rmid = entry['note'].get('reply_message_id')
                if rmid:
                    completed_reply_ids.add(rmid)
        if len(completed_reply_ids) > 1:
            consistent = False
        terminals_seen = set(g['parsed']['state'] for g in group if g['parsed']['state'] in TERMINAL_STATES)
        if len(terminals_seen) > 1:
            consistent = False

        if not consistent:
            discussion_invalid = True
            note({
                'code': 'attempt_identity_conflict',
                'message_id': head_id,
                'detail': f"Attempt '{attempt_id}' has internally inconsistent receipts (head/turn/agent/deadline must all agree, and at most one completed reply id / terminal state is permitted)",
            })
            continue

        if head_id == root['message']['id']:
            head_msg = root['message']
        elif head_id in globally_valid:
            head_msg = valid[head_id]['message']
        else:
            head_msg = None
        if head_msg is None:
            note({
                'code': 'receipt_on_invalid_head',
                'message_id': head_id,
                'detail': f"Attempt '{attempt_id}' is bound to a head that is not a validated, participant/fleet-valid discussion candidate",
            })
            continue

        expected_agent = head_msg.get('to_agent_id')
        if agent_id != expected_agent:
            note({
                'code': 'unauthorized_attempt_agent',
                'message_id': head_id,
                'detail': f"Attempt '{attempt_id}' acted as '{agent_id}', expected '{expected_agent}'",
            })
            continue

        candidates = []
        for entry in group:
            if entry['parsed']['state'] != 'completed':
                candidates.append(entry)
                continue
            ts = entry['receipt'].get('timestamp')
            on_time = ts is not None and ts <= deadline and ts <= policy['conversation_deadline']
            if not on_time:
                note({
                    'code': 'late_completion',
                    'message_id': head_id,
                    'detail': f"Attempt '{attempt_id}' completed at {ts}, after its deadline ({deadline}) or the conversation deadline ({policy['conversation_deadline']})",
                })
            if on_time:
                candidates.append(entry)

        if not candidates:
            continue

        best = candidates[0]
        for entry in candidates:
            if RANK[entry['parsed']['state']] >= RANK[best['parsed']['state']]:
                best = entry

        reply_message_id = best['note'].get('reply_message_id') if best['parsed']['state'] == 'completed' else None
        valid_attempts[attempt_id] = {
            'attempt_id': attempt_id,
            'turn': turn,
            'agent_id': agent_id,
            'head_message_id': head_id,
            'state': best['parsed']['state'],
            'deadline': deadline,
            'reply_message_id': reply_message_id,
        }

    completed_by_head = {}
    for attempt in valid_attempts.values():
        if attempt['state'] != 'completed':
            continue
        h = attempt['head_message_id']
        if h not in completed_by_head:
            completed_by_head[h] = []
        completed_by_head[h].append(attempt)

    canonical_attempt_ids = set()
    attempts_explained = set()

    def is_beyond_budget(turn):
        return turn > policy['max_turns']

    # Budget pass
    for attempt_id, attempt in valid_attempts.items():
        if is_beyond_budget(attempt['turn']):
            attempts_explained.add(attempt_id)
            note({
                'code': 'attempt_beyond_budget',
                'message_id': attempt['head_message_id'],
                'detail': f"Attempt '{attempt_id}' claims turn {attempt['turn']}, beyond the immutable max_turns budget of {policy['max_turns']}",
            })

    by_reply_to = {}
    for candidate in valid.values():
        if candidate['message']['id'] == root['message']['id']:
            continue
        key = candidate['envelope']['reply_to']
        if key is None:
            continue
        if key not in by_reply_to:
            by_reply_to[key] = []
        by_reply_to[key].append(candidate)

    canonical_chain = [{'candidate': root, 'turn': 1}]
    current_head = root['message']['id']
    current_turn = 1
    visited_heads = {root['message']['id']}

    def register_contiguous_tail(head_id, from_turn):
        attempts_at_head = [a for a in valid_attempts.values() if a['head_message_id'] == head_id]
        t = from_turn
        while True:
            at_turn = next((a for a in attempts_at_head if a['turn'] == t), None)
            if at_turn is None:
                break
            if is_beyond_budget(at_turn['turn']):
                if at_turn['state'] in ('failed', 'deadman'):
                    t += 1
                    continue
                break
            canonical_attempt_ids.add(at_turn['attempt_id'])
            attempts_explained.add(at_turn['attempt_id'])
            if at_turn['state'] == 'deadman':
                break
            if at_turn['state'] != 'failed':
                break
            t += 1

    while True:
        bucket = [c for c in (by_reply_to.get(current_head) or []) if c['message']['id'] in globally_valid]
        if not bucket:
            register_contiguous_tail(current_head, current_turn + 1)
            break

        prev = canonical_chain[-1]['candidate']['message']
        expected_from = prev.get('to_agent_id')
        expected_to = prev.get('from_agent_id')

        alternation_valid = []
        for candidate in bucket:
            if (candidate['message'].get('from_agent_id') != expected_from or
                candidate['message'].get('to_agent_id') != expected_to):
                discussion_invalid = True
                note({
                    'code': 'invalid_sender',
                    'message_id': candidate['message']['id'],
                    'detail': f"Sender/recipient do not alternate: expected {expected_from}->{expected_to}, got {candidate['message'].get('from_agent_id')}->{candidate['message'].get('to_agent_id')}",
                })
                continue
            alternation_valid.append(candidate)

        candidate_attempts = completed_by_head.get(current_head) or []
        authorized = []
        for candidate in alternation_valid:
            attempt = next((a for a in candidate_attempts
                          if a['reply_message_id'] == candidate['message']['id'] and
                          a['turn'] == candidate['envelope']['turn'] and
                          a['attempt_id'] == candidate['envelope']['attempt_id']), None)
            if attempt:
                authorized.append({'candidate': candidate, 'attempt': attempt})
                explained.add(candidate['message']['id'])
            else:
                note({
                    'code': 'unauthorized_reply',
                    'message_id': candidate['message']['id'],
                    'detail': f"No validated, agent-authorized completed wake attempt (matching reply id, turn, AND attempt id) admits this reply at head '{current_head}'",
                })

        if not authorized:
            register_contiguous_tail(current_head, current_turn + 1)
            break
        if len(authorized) > 1:
            discussion_invalid = True
            for contender in authorized:
                note({
                    'code': 'fork',
                    'message_id': contender['candidate']['message']['id'],
                    'detail': f"Two or more authorized replies target head '{current_head}'",
                })
            break

        winner = authorized[0]['candidate']
        attempt = authorized[0]['attempt']

        if is_beyond_budget(attempt['turn']):
            break

        attempts_at_this_head = [a for a in valid_attempts.values() if a['head_message_id'] == current_head]
        gap_ok = attempt['turn'] > current_turn
        deadman_encountered = None
        fillers = []
        if gap_ok:
            for t in range(current_turn + 1, attempt['turn']):
                filler = next((a for a in attempts_at_this_head if a['turn'] == t), None)
                if filler and not is_beyond_budget(filler['turn']) and filler['state'] == 'deadman':
                    deadman_encountered = filler
                    gap_ok = False
                    break
                if not filler or filler['state'] != 'failed' or is_beyond_budget(filler['turn']):
                    gap_ok = False
                    break
                fillers.append(filler)

        if deadman_encountered:
            for filler in fillers:
                canonical_attempt_ids.add(filler['attempt_id'])
                attempts_explained.add(filler['attempt_id'])
            canonical_attempt_ids.add(deadman_encountered['attempt_id'])
            attempts_explained.add(deadman_encountered['attempt_id'])
            break

        if not gap_ok:
            discussion_invalid = True
            attempts_explained.add(attempt['attempt_id'])
            note({
                'code': 'ordinal_discontinuity',
                'message_id': current_head,
                'detail': f"Attempt '{attempt['attempt_id']}' claims turn {attempt['turn']} directly from turn {current_turn} at head '{current_head}' without a validated failed reservation for every intervening turn",
            })
            break

        for filler in fillers:
            canonical_attempt_ids.add(filler['attempt_id'])
            attempts_explained.add(filler['attempt_id'])
        canonical_attempt_ids.add(attempt['attempt_id'])
        attempts_explained.add(attempt['attempt_id'])

        canonical_chain.append({'candidate': winner, 'turn': attempt['turn']})
        current_head = winner['message']['id']
        current_turn = attempt['turn']
        visited_heads.add(current_head)

        if winner['envelope']['close'] is True:
            break

    transcript = [
        {
            'turn': entry['turn'],
            'message': entry['candidate']['message'],
            'receipts': [r for r in receipts if r.get('message_id') == entry['candidate']['message']['id']],
        }
        for entry in canonical_chain
    ]

    for msg_id in valid:
        if msg_id in explained:
            continue
        findings.append({
            'code': 'unreachable_envelope',
            'message_id': msg_id,
            'detail': 'Valid discussion/v1 envelope never connects to the canonical chain from the root',
        })

    canonical_attempts = {}
    for attempt_id, attempt in valid_attempts.items():
        if attempt_id in canonical_attempt_ids:
            canonical_attempts[attempt_id] = attempt
        elif attempt_id not in attempts_explained:
            note({
                'code': 'receipt_on_invalid_head',
                'message_id': attempt['head_message_id'],
                'detail': (f"Attempt '{attempt_id}' is bound to a reached head but is not part of the continuous canonical reservation sequence"
                           if attempt['head_message_id'] in visited_heads else
                           f"Attempt '{attempt_id}' is bound to a head the canonical walk never reached from the root"),
            })

    turn_to_attempt_ids = {}
    for attempt in valid_attempts.values():
        if attempt['head_message_id'] not in visited_heads:
            continue
        if is_beyond_budget(attempt['turn']):
            continue
        t = attempt['turn']
        if t not in turn_to_attempt_ids:
            turn_to_attempt_ids[t] = []
        turn_to_attempt_ids[t].append(attempt['attempt_id'])

    for turn, attempt_ids in turn_to_attempt_ids.items():
        if len(attempt_ids) > 1:
            discussion_invalid = True
            for attempt_id in attempt_ids:
                attempt = valid_attempts[attempt_id]
                note({
                    'code': 'duplicate_turn',
                    'message_id': attempt['head_message_id'],
                    'detail': f"Turn {turn} is claimed by more than one validated reservation (attempt '{attempt_id}')",
                })

    distinct_turns_sorted = sorted(turn_to_attempt_ids.keys())
    for i, turn in enumerate(distinct_turns_sorted):
        expected = 2 + i
        if turn != expected:
            discussion_invalid = True
            findings.append({
                'code': 'ordinal_discontinuity',
                'detail': f"Validated reservations jump to turn {turn} without a turn {expected} ever being reserved",
            })
            break

    turns_used = 1 + len(canonical_attempts)
    turns_remaining = max(0, policy['max_turns'] - turns_used)

    attempts_list = [
        {
            'attempt_id': a['attempt_id'],
            'turn': a['turn'],
            'agent_id': a['agent_id'],
            'state': a['state'],
            'deadline': a['deadline'],
            'reply_message_id': a['reply_message_id'],
        }
        for a in canonical_attempts.values()
    ]

    status = _recompute_status(
        invalid=discussion_invalid,
        transcript=transcript,
        root_message_id=root['message']['id'],
        attempts=attempts_list,
        policy=policy,
        now=now,
        turns_used=turns_used,
    )

    return {
        'status': status,
        'turns_used': turns_used,
        'turns_remaining': turns_remaining,
        'transcript': transcript,
        'attempts': attempts_list,
        'integrity_findings': findings,
    }


deriveDiscussion = derive_discussion
