#!/usr/bin/env python3
"""Independent standard-library witness for the dormant A2A capability profile."""
import hashlib
import json
import re
import struct
import sys

SAFE = 9007199254740991
PV = "meshfleet.a2a.capability-profile/v0.1"
VV = "meshfleet.a2a.capability-validation/v0.1"
TV = "meshfleet.a2a.translation/v0.1"
TRV = "meshfleet.a2a.translation-result/v0.1"
TRVV = "meshfleet.a2a.translation-result-validation/v0.1"
RV = "meshfleet.a2a.conformance-registry/v0.1"
TARGETS = ("codex","claude-code","opencode","generic-mcp","generic-cli-stdio","antigravity-gemini","grok","unknown-future-harness")
DEFERRED = {"antigravity-gemini","grok","unknown-future-harness"}
PRIVACY = {"principal_id","request_id","message_id","recipient","recipients","credential","credentials","token","api_key","secret","password","private_key","pem","prompt","payload","output","diagnostic","diagnostics","path","cwd","argv","args","argument","arguments","url","uri","endpoint","environment","env","env_values","hostname","pid","process_id","account_id","hardware_id","receipt","receipt_id","artifact"}
COMPUTED = {"verification_status","verification_report","verified_at_ms","verifier_ref","failure_reason","profile_fingerprint","claim_fingerprint","proof_results","conformance_status"}
LOSS_REASONS = {"field_not_represented","target_schema_unknown","cwd_not_represented","capability_not_proven","runtime_identity_not_attested","semantic_gap","unsupported_transport","contradictory_provenance","static_template_unavailable","unsupported_feature","requires_human_gate"}
LOSS_DISPOSITIONS = {"preserved_unknown","rejected","omitted_by_contract","requires_human_gate"}

def asc(v): return v.encode("utf-8")
def err(code, path): return {"code": code, "field_path": path}
def is_obj(v): return isinstance(v, dict)
def valid_time(v): return type(v) is int and 0 <= v <= SAFE
def opaque(v): return isinstance(v,str) and re.fullmatch(r"ref_[A-Za-z0-9_-]{20,84}",v) is not None
def profile_id(v): return isinstance(v,str) and re.fullmatch(r"cp_[A-Za-z0-9_-]{20,84}",v) is not None
def claim_id(v): return isinstance(v,str) and re.fullmatch(r"clm_[A-Za-z0-9_-]{20,84}",v) is not None
def canonical_id(v): return isinstance(v,str) and len(v.encode()) <= 96 and re.fullmatch(r"[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*",v) is not None
def exact_version(v): return isinstance(v,str) and len(v.encode()) <= 32 and re.fullmatch(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:\.(?:0|[1-9][0-9]*))?",v) is not None
def protocol_ref(v):
    if not isinstance(v,str) or len(v.encode()) > 129 or "/" not in v: return False
    a,b=v.rsplit("/",1); return canonical_id(a) and exact_version(b)
def label(v): return isinstance(v,str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._+@-]{0,95}",v) is not None
def nonce(v): return isinstance(v,str) and re.fullmatch(r"nonce_[A-Za-z0-9_-]{20,84}",v) is not None
def proof_digest(v): return isinstance(v,str) and re.fullmatch(r"sha256:[0-9a-f]{64}",v) is not None
def field_path(v): return isinstance(v,str) and (v == "$evaluation_time_ms" or re.fullmatch(r"\$(?:\.[a-z][a-z0-9_]*|\[[0-9]+\])*",v) is not None)
def sort_errors(items): return sorted(items,key=lambda x:(asc(x["code"]),asc(x["field_path"])))
def path(base,k): return base+"."+k
RAW_INVALID = object()
def _pairs(items):
    out={}
    for key,value in items:
        if key in out: raise ValueError("duplicate decoded key")
        out[key]=value
    return out
def _integer(text):
    value=int(text)
    if abs(value)>SAFE: raise ValueError("unsafe integer")
    return value
def _constant(_): raise ValueError("nonstandard number")
def _tree_domain(v,depth=1):
    if depth>64: return False
    if v is None or type(v) is bool: return True
    if type(v) is int: return abs(v)<=SAFE
    if type(v) is float: return v == v and abs(v) != float("inf")
    if isinstance(v,str):
        try: v.encode("utf-8")
        except UnicodeEncodeError: return False
        return True
    if isinstance(v,list): return all(_tree_domain(x,depth+1) for x in v)
    if is_obj(v): return all(_tree_domain(k,depth+1) and _tree_domain(x,depth+1) for k,x in v.items())
    return False
def parsed(v):
    if isinstance(v,str):
        try:
            if len(v.encode("utf-8"))>131072: return RAW_INVALID
            out=json.loads(v,object_pairs_hook=_pairs,parse_int=_integer,parse_constant=_constant)
        except Exception: return RAW_INVALID
        return out if _tree_domain(out) else RAW_INVALID
    if not _tree_domain(v): return RAW_INVALID
    try: return v if len(json.dumps(v,separators=(",",":"),ensure_ascii=False).encode("utf-8"))<=131072 else RAW_INVALID
    except Exception: return RAW_INVALID
def u64(n): return struct.pack(">Q",n)
def tree(v):
    if v is None: return b"\x00"
    if v is False: return b"\x01"
    if v is True: return b"\x02"
    if isinstance(v,(int,float)) and not isinstance(v,bool): return b"\x03"+struct.pack(">d",0.0 if v == 0 else v)
    if isinstance(v,str):
        x=v.encode(); return b"\x04"+u64(len(x))+x
    if isinstance(v,list): return b"\x05"+u64(len(v))+b"".join(tree(x) for x in v)
    if isinstance(v,dict):
        bits=[]
        for key in sorted(v,key=asc):
            x=key.encode(); bits.extend((b"\x04",u64(len(x)),x,tree(v[key])))
        return b"\x06"+u64(len(v))+b"".join(bits)
    raise ValueError("json only")
def fp(domain,value,label): return label+":sha256:"+hashlib.sha256(domain.encode()+b"\x00"+tree(value)).hexdigest()
def unknown(obj, allowed, base, errors, computed=False):
    for key in obj:
        if key not in allowed: errors.append(err("FORBIDDEN_COMPUTED_FIELD" if computed and key in COMPUTED else "UNKNOWN_CORE_FIELD",path(base,key) if computed and key in COMPUTED else base))
def required(obj, keys, base, errors, code):
    for key in keys:
        if key not in obj: errors.append(err(code,path(base,key)))
def ext(obj, base, errors):
    if not is_obj(obj.get("extensions")): errors.append(err("INVALID_EXTENSION_CONTAINER",path(base,"extensions")))
    if not isinstance(obj.get("critical_extensions"),list): errors.append(err("INVALID_EXTENSION_CONTAINER",path(base,"critical_extensions")))
    if is_obj(obj.get("extensions")) and obj["extensions"]: errors.append(err("UNSUPPORTED_EXTENSION",path(base,"extensions")))
    if isinstance(obj.get("critical_extensions"),list) and obj["critical_extensions"]: errors.append(err("UNSUPPORTED_EXTENSION",path(base,"critical_extensions")))
def norm_set(value,limit,validator,base,errors):
    if not isinstance(value,list) or len(value)>limit: errors.append(err("INVALID_APPLICABILITY",base)); return []
    seen=set(); out=[]
    for i,item in enumerate(value):
        if not validator(item): errors.append(err("INVALID_APPLICABILITY",f"{base}[{i}]"))
        elif item in seen: errors.append(err("DUPLICATE_SET_MEMBER",f"{base}[{i}]"))
        else: seen.add(item); out.append(item)
    return sorted(out,key=asc)
def norm_app(v,base,errors):
    if not is_obj(v): errors.append(err("INVALID_APPLICABILITY",base)); return {"protocol_versions":[],"transport_families":[],"operations":[]}
    required(v,["protocol_versions","transport_families","operations"],base,errors,"INVALID_APPLICABILITY"); unknown(v,["protocol_versions","transport_families","operations"],base,errors)
    return {"protocol_versions":norm_set(v.get("protocol_versions"),16,protocol_ref,path(base,"protocol_versions"),errors),"transport_families":norm_set(v.get("transport_families"),16,canonical_id,path(base,"transport_families"),errors),"operations":norm_set(v.get("operations"),32,canonical_id,path(base,"operations"),errors)}
def norm_provenance(v,claim,base,errors):
    if not is_obj(v) or v.get("level") not in {"advertised","reported","observed","attested"}:
        errors.append(err("INVALID_PROVENANCE",base)); return {"level":"advertised"}
    level=v["level"]
    req={"advertised":["level"],"reported":["level","issuer_ref"],"observed":["level","issuer_ref","observed_at_ms","probe_ref"],"attested":["level","issuer_ref"]}[level]
    required(v,req,base,errors,"INVALID_PROVENANCE"); unknown(v,req,base,errors)
    if level!="advertised" and not opaque(v.get("issuer_ref")): errors.append(err("INVALID_PROVENANCE",path(base,"issuer_ref")))
    if level=="observed":
        observed=v.get("observed_at_ms")
        if not valid_time(observed) or not valid_time(claim.get("issued_at_ms")) or not valid_time(claim.get("expires_at_ms")) or observed<claim["issued_at_ms"] or observed>=claim["expires_at_ms"]: errors.append(err("INVALID_PROVENANCE",path(base,"observed_at_ms")))
        if not opaque(v.get("probe_ref")): errors.append(err("INVALID_PROVENANCE",path(base,"probe_ref")))
    return {key:v[key] for key in req if key in v}
PROOF_ABSENT=object()
def norm_proof(v,claim,provenance,base,errors):
    if v is PROOF_ABSENT:
        if provenance.get("level")=="attested": errors.append(err("INVALID_PROOF_CARRIER",base))
        return None
    if not is_obj(v): errors.append(err("INVALID_PROOF_CARRIER",base)); return None
    req=["issuer_ref","audience_ref","issued_at_ms","not_before_ms","expires_at_ms","challenge","proof_format","verification_method_ref"]
    required(v,req,base,errors,"INVALID_PROOF_CARRIER")
    has_digest="proof_digest" in v; has_ref="proof_ref" in v
    if has_digest==has_ref: errors.append(err("INVALID_PROOF_CARRIER",base))
    unknown(v,req+["proof_digest","proof_ref"],base,errors,True)
    for key in ["issuer_ref","audience_ref","verification_method_ref"]:
        if not opaque(v.get(key)): errors.append(err("INVALID_PROOF_CARRIER",path(base,key)))
    if not nonce(v.get("challenge")): errors.append(err("INVALID_PROOF_CARRIER",path(base,"challenge")))
    if not label(v.get("proof_format")): errors.append(err("INVALID_PROOF_CARRIER",path(base,"proof_format")))
    if has_digest and not proof_digest(v.get("proof_digest")): errors.append(err("INVALID_PROOF_CARRIER",path(base,"proof_digest")))
    if has_ref and not opaque(v.get("proof_ref")): errors.append(err("INVALID_PROOF_CARRIER",path(base,"proof_ref")))
    if provenance.get("issuer_ref") is not None and v.get("issuer_ref")!=provenance.get("issuer_ref"): errors.append(err("INVALID_PROOF_CARRIER",path(base,"issuer_ref")))
    window=[v.get("issued_at_ms"),v.get("not_before_ms"),v.get("expires_at_ms")]
    if not all(valid_time(x) for x in window) or not valid_time(claim.get("issued_at_ms")) or not valid_time(claim.get("expires_at_ms")) or (all(valid_time(x) for x in window) and (window[0]<claim["issued_at_ms"] or window[0]>window[1] or window[1]>=window[2] or window[2]>claim["expires_at_ms"])): errors.append(err("INVALID_PROOF_CARRIER",path(base,"expires_at_ms")))
    return {key:v[key] for key in req+["proof_digest" if has_digest else "proof_ref"] if key in v}
def norm_claim(v,base,errors,defer):
    if not is_obj(v): errors.append(err("INVALID_CLAIM_SCHEMA",base)); return None
    common=["claim_id","kind","applicability","provenance","issued_at_ms","expires_at_ms","extensions","critical_extensions"]
    required(v,[key for key in common if not defer or key not in {"extensions","critical_extensions"}],base,errors,"INVALID_CLAIM_SCHEMA")
    if not claim_id(v.get("claim_id")): errors.append(err("INVALID_CLAIM_SCHEMA",path(base,"claim_id")))
    kind=v.get("kind") if v.get("kind") in {"capability","transport","protocol","runtime","provider","model"} else "capability"
    if v.get("kind") not in {"capability","transport","protocol","runtime","provider","model"}: errors.append(err("INVALID_CLAIM_KIND",path(base,"kind")))
    specific={"capability":["capability_id","state"],"transport":["transport_id","state"],"protocol":["protocol_id","protocol_version","state"],"runtime":["runtime_label"],"provider":["provider_label"],"model":["model_label"]}[kind]
    unknown(v,common+["proof"]+specific,base,errors,True)
    if not valid_time(v.get("issued_at_ms")) or not valid_time(v.get("expires_at_ms")) or (valid_time(v.get("issued_at_ms")) and valid_time(v.get("expires_at_ms")) and v["issued_at_ms"]>=v["expires_at_ms"]): errors.append(err("INVALID_TIME_WINDOW",path(base,"expires_at_ms")))
    app=norm_app(v.get("applicability"),path(base,"applicability"),errors)
    shell={"issued_at_ms":v.get("issued_at_ms"),"expires_at_ms":v.get("expires_at_ms")}
    provn=norm_provenance(v.get("provenance"),shell,path(base,"provenance"),errors)
    proof=norm_proof(v["proof"] if "proof" in v else PROOF_ABSENT,shell,provn,path(base,"proof"),errors)
    if not defer: ext(v,base,errors)
    out={"claim_id":v.get("claim_id"),"kind":kind,"applicability":app,"provenance":provn,"issued_at_ms":v.get("issued_at_ms"),"expires_at_ms":v.get("expires_at_ms"),"extensions":v.get("extensions"),"critical_extensions":v.get("critical_extensions")}
    if proof is not None: out["proof"]=proof
    if kind=="capability":
        if not canonical_id(v.get("capability_id")): errors.append(err("INVALID_CANONICAL_ID",path(base,"capability_id")))
        out["capability_id"]=v.get("capability_id")
    if kind=="transport":
        if not canonical_id(v.get("transport_id")): errors.append(err("INVALID_CANONICAL_ID",path(base,"transport_id")))
        out["transport_id"]=v.get("transport_id")
    if kind=="protocol":
        if not canonical_id(v.get("protocol_id")): errors.append(err("INVALID_CANONICAL_ID",path(base,"protocol_id")))
        if not exact_version(v.get("protocol_version")): errors.append(err("INVALID_PROTOCOL_VERSION",path(base,"protocol_version")))
        out["protocol_id"]=v.get("protocol_id"); out["protocol_version"]=v.get("protocol_version")
    if kind in {"capability","transport","protocol"}:
        if v.get("state") not in {"supported","unsupported","unknown"}: errors.append(err("INVALID_CLAIM_SCHEMA",path(base,"state")))
        out["state"]=v.get("state")
    if kind in {"runtime","provider","model"}:
        key=kind+"_label"
        if not label(v.get(key)): errors.append(err("INVALID_ASCII_LABEL",path(base,key)))
        out[key]=v.get(key)
    return out
def profile(raw,base="$",defer=False):
    raw=parsed(raw); errors=[]
    if not is_obj(raw): return {},[],[err("MALFORMED_CAPABILITY_PROFILE",base)]
    keys=["profile_version","profile_id","revision","issuer","subject","issued_at_ms","expires_at_ms","claims","extensions","critical_extensions"]
    required(raw,[key for key in keys if not defer or key not in {"extensions","critical_extensions"}],base,errors,"MALFORMED_CAPABILITY_PROFILE"); unknown(raw,keys,base,errors,True)
    if raw.get("profile_version")!=PV: errors.append(err("UNSUPPORTED_PROFILE_VERSION",path(base,"profile_version")))
    if not profile_id(raw.get("profile_id")): errors.append(err("MALFORMED_CAPABILITY_PROFILE",path(base,"profile_id")))
    if type(raw.get("revision")) is not int or raw.get("revision",0)<=0: errors.append(err("INVALID_PROFILE_REVISION",path(base,"revision")))
    for key,kinds in (("issuer",{"agent","adapter","runtime","authority"}),("subject",{"agent","adapter","runtime","transport"})):
        item=raw.get(key); p=path(base,key)
        if not is_obj(item): errors.append(err("MALFORMED_CAPABILITY_PROFILE",p)); continue
        required(item,["kind","ref"],p,errors,"MALFORMED_CAPABILITY_PROFILE"); unknown(item,["kind","ref"],p,errors)
        if item.get("kind") not in kinds: errors.append(err("MALFORMED_CAPABILITY_PROFILE",path(p,"kind")))
        if not opaque(item.get("ref")): errors.append(err("INVALID_OPAQUE_REFERENCE",path(p,"ref")))
    if not valid_time(raw.get("issued_at_ms")) or not valid_time(raw.get("expires_at_ms")) or (valid_time(raw.get("issued_at_ms")) and valid_time(raw.get("expires_at_ms")) and raw["issued_at_ms"]>=raw["expires_at_ms"]): errors.append(err("INVALID_TIME_WINDOW",path(base,"expires_at_ms")))
    claims=[]
    if not isinstance(raw.get("claims"),list) or len(raw.get("claims",[]))>128: errors.append(err("MALFORMED_CAPABILITY_PROFILE",path(base,"claims")))
    else:
        for i,item in enumerate(raw["claims"]):
            q=norm_claim(item,f"{base}.claims[{i}]",errors,defer)
            if q is not None: claims.append((q,i))
    seen=set()
    for q,i in claims:
        if q["claim_id"] in seen: errors.append(err("DUPLICATE_SET_MEMBER",f"{base}.claims[{i}].claim_id"))
        seen.add(q["claim_id"])
    if not defer: ext(raw,base,errors)
    # Do not attempt canonical ordering of a structurally incomplete claim;
    # its source position remains the only valid diagnostic coordinate.
    if not defer and not errors: claims.sort(key=lambda x:tree(x[0]))
    return {"profile_version":raw.get("profile_version"),"profile_id":raw.get("profile_id"),"revision":raw.get("revision"),"issuer":raw.get("issuer"),"subject":raw.get("subject"),"issued_at_ms":raw.get("issued_at_ms"),"expires_at_ms":raw.get("expires_at_ms"),"claims":[x[0] for x in claims],"extensions":raw.get("extensions"),"critical_extensions":raw.get("critical_extensions")},claims,sort_errors(errors)
def claim_fp(p,c): return fp("meshfleet.a2a.capability-claim.v1",[p["issuer"]["ref"],p["subject"]["ref"],p["profile_id"],c["claim_id"],p["revision"],c],"meshfleet.a2a.capability-claim.v1")
def contradiction_errors(p,claims,base):
    groups={}
    for c,_ in claims:
        if c.get("kind") in {"capability","transport","protocol"} and c.get("state") in {"supported","unsupported","unknown"}:
            key=json.dumps([p["subject"]["ref"],c["kind"],c.get("capability_id",c.get("transport_id",c.get("protocol_id"))),c.get("protocol_version",""),c["applicability"]],separators=(",",":"),sort_keys=True)
            groups.setdefault(key,set()).add(c["state"])
    return [err("CONTRADICTORY_CLAIMS",path(base,"claims"))] if any("supported" in states and "unsupported" in states for states in groups.values()) else []
def semantic(p,claims,t,base):
    es=contradiction_errors(p,claims,base)
    if t<p["issued_at_ms"]: es.append(err("NOT_YET_VALID_PROFILE",path(base,"issued_at_ms")))
    if t>=p["expires_at_ms"]: es.append(err("EXPIRED_PROFILE",path(base,"expires_at_ms")))
    for c,i in claims:
        if t<c["issued_at_ms"]: es.append(err("NOT_YET_VALID_CLAIM",f"{base}.claims[{i}].issued_at_ms"))
        if t>=c["expires_at_ms"]: es.append(err("EXPIRED_CLAIM",f"{base}.claims[{i}].expires_at_ms"))
        proof=c.get("proof")
        if is_obj(proof):
            if t<proof["issued_at_ms"] or t<proof["not_before_ms"]: es.append(err("NOT_YET_VALID_PROOF",f"{base}.claims[{i}].proof.not_before_ms"))
            if t>=proof["expires_at_ms"]: es.append(err("EXPIRED_PROOF",f"{base}.claims[{i}].proof.expires_at_ms"))
    return sort_errors(es)
def validate_profile(raw,t=None):
    if not valid_time(t): return {"ok":False,"error":err("INVALID_EVALUATION_TIME","$evaluation_time_ms")}
    p,cs,es=profile(raw)
    if es: return {"ok":True,"value":{"validation_version":VV,"evaluation_time_ms":t,"valid":False,"proof_results":[],"errors":es}}
    errors=semantic(p,cs,t,"$"); proof=[{"claim_id":c["claim_id"],"claim_fingerprint":claim_fp(p,c),"verification_status":"unsupported" if "proof" in c else "absent"} for c,i in cs]
    proof.sort(key=lambda x:(asc(x["claim_id"]),asc(json.dumps(x,separators=(",",":"),sort_keys=True))))
    return {"ok":True,"value":{"validation_version":VV,"evaluation_time_ms":t,"valid":not errors,"profile_fingerprint":fp("meshfleet.a2a.capability-profile.v1",p,"meshfleet.a2a.capability-profile.v1"),"proof_results":proof,"errors":errors}}
def template(v): return is_obj(v) and len(v)==3 and ((v.get("template_id")=="none" and v.get("command")=="none" and v.get("argv_template")==[]) or (v.get("template_id")=="meshfleet.mcp-stdio/v1" and v.get("command")=="npx" and v.get("argv_template")==["-y","meshfleet"]))
def scan_privacy(v,base,out):
    if isinstance(v,list):
        for i,x in enumerate(v): scan_privacy(x,f"{base}[{i}]",out)
    elif is_obj(v):
        for k,x in v.items():
            if k=="extensions": continue
            n=k.lower(); q=path(base,n)
            if n in PRIVACY: out.append(q)
            scan_privacy(x,q,out)
SCHEMAS={
    "translation":{"translation_version","target","source_profile","launch_template","cwd_policy","features","provenance_refs","extensions","critical_extensions"},
    "result":{"translation_version","target","launch_template","cwd_policy","features","provenance_refs","profile","losses","extensions","critical_extensions"},
    "profile":{"profile_version","profile_id","revision","issuer","subject","issued_at_ms","expires_at_ms","claims","extensions","critical_extensions"},
    "identity":{"kind","ref"},
    "claim":{"claim_id","kind","applicability","provenance","issued_at_ms","expires_at_ms","extensions","critical_extensions","proof","capability_id","transport_id","protocol_id","protocol_version","state","runtime_label","provider_label","model_label"},
    "applicability":{"protocol_versions","transport_families","operations"},
    "provenance":{"level","issuer_ref","observed_at_ms","probe_ref"},
    "proof":{"issuer_ref","audience_ref","issued_at_ms","not_before_ms","expires_at_ms","challenge","proof_format","verification_method_ref","proof_digest","proof_ref"},
    "template":{"template_id","command","argv_template"},
    "feature":{"feature_id","state","provenance_ref"},
    "loss":{"field_path","target","reason_code","disposition"},
}
def scan_closed(v,schema,base,out):
    if not is_obj(v): return
    allowed=SCHEMAS[schema]
    if schema=="claim" and v.get("kind") in {"capability","transport","protocol","runtime","provider","model"}:
        specific={"capability":{"capability_id","state"},"transport":{"transport_id","state"},"protocol":{"protocol_id","protocol_version","state"},"runtime":{"runtime_label"},"provider":{"provider_label"},"model":{"model_label"}}[v["kind"]]
        allowed={"claim_id","kind","applicability","provenance","issued_at_ms","expires_at_ms","extensions","critical_extensions","proof"}|specific
    for key in v:
        if key not in allowed:
            if key in COMPUTED: out["computed"].append(path(base,key))
            elif schema!="loss": out["unknown"].append(base)
    if schema=="translation":
        scan_closed(v.get("source_profile"),"profile","$.source_profile",out); scan_closed(v.get("launch_template"),"template","$.launch_template",out)
        if isinstance(v.get("features"),list):
            for i,x in enumerate(v["features"]): scan_closed(x,"feature",f"$.features[{i}]",out)
    elif schema=="result":
        scan_closed(v.get("profile"),"profile","$.profile",out); scan_closed(v.get("launch_template"),"template","$.launch_template",out)
        if isinstance(v.get("features"),list):
            for i,x in enumerate(v["features"]): scan_closed(x,"feature",f"$.features[{i}]",out)
        if isinstance(v.get("losses"),list):
            for i,x in enumerate(v["losses"]): scan_closed(x,"loss",f"$.losses[{i}]",out)
    elif schema=="profile":
        scan_closed(v.get("issuer"),"identity",path(base,"issuer"),out); scan_closed(v.get("subject"),"identity",path(base,"subject"),out)
        if isinstance(v.get("claims"),list):
            for i,x in enumerate(v["claims"]): scan_closed(x,"claim",f"{base}.claims[{i}]",out)
    elif schema=="claim":
        scan_closed(v.get("applicability"),"applicability",path(base,"applicability"),out); scan_closed(v.get("provenance"),"provenance",path(base,"provenance"),out); scan_closed(v.get("proof"),"proof",path(base,"proof"),out)
def closed_error(v,schema):
    out={"computed":[],"unknown":[]}; scan_closed(v,schema,"$",out)
    if out["computed"]: return err("FORBIDDEN_COMPUTED_FIELD",sorted(out["computed"],key=asc)[0])
    if out["unknown"]: return err("UNKNOWN_CORE_FIELD",sorted(set(out["unknown"]),key=asc)[0])
    return None
def ext_translation(raw):
    es=[]; ext(raw,"$",es)
    p=raw.get("source_profile")
    if is_obj(p):
        ext(p,"$.source_profile",es)
        if isinstance(p.get("claims"),list):
            for i,c in enumerate(p["claims"]):
                if is_obj(c): ext(c,f"$.source_profile.claims[{i}]",es)
    return es
def features(v,base):
    if not isinstance(v,list) or len(v)>64: return [],[],err("INVALID_TRANSLATION_INPUT",base)
    source=[]; invalid=[]
    for i,x in enumerate(v):
        q=f"{base}[{i}]"
        if not is_obj(x): invalid.append(q); continue
        members=[]
        if not canonical_id(x.get("feature_id")): members.append(path(q,"feature_id"))
        if not opaque(x.get("provenance_ref")): members.append(path(q,"provenance_ref"))
        if x.get("state") not in {"supported","unsupported","unknown","not-represented"}: members.append(path(q,"state"))
        if members: invalid.append(sorted(members,key=asc)[0]); continue
        source.append(({"feature_id":x["feature_id"],"state":x["state"],"provenance_ref":x["provenance_ref"]},i))
    if invalid: return [],source,err("INVALID_TRANSLATION_INPUT",sorted(invalid,key=asc)[0])
    seen=set()
    for x,i in source:
        if x["feature_id"] in seen: return [],source,err("INVALID_TRANSLATION_INPUT",f"{base}[{i}].feature_id")
        seen.add(x["feature_id"])
    return sorted([x for x,_ in source],key=tree),source,None
def refs(v,base,fs):
    if not isinstance(v,list) or len(v)>64: return [],err("INVALID_TRANSLATION_INPUT",base)
    seen=set(); out=[]
    for i,x in enumerate(v):
        if not opaque(x): return [],err("INVALID_TRANSLATION_INPUT",f"{base}[{i}]")
        if x in seen: return [],err("DUPLICATE_SET_MEMBER",f"{base}[{i}]")
        seen.add(x); out.append(x)
    missing=sorted([(i,f) for f,i in fs if f["provenance_ref"] not in seen],key=lambda x:x[0])
    if missing: return [],err("INVALID_TRANSLATION_INPUT",f"$.features[{missing[0][0]}].provenance_ref")
    return sorted(out,key=asc),None
def terr(code,p,t): return {"code":code,"field_path":p,"target_ref":t}
def translate_profile(inp,t=None):
    if not valid_time(t): return terr("INVALID_EVALUATION_TIME","$evaluation_time_ms","invalid")
    raw=parsed(inp)
    if not is_obj(raw): return terr("INVALID_TRANSLATION_INPUT","$","invalid")
    target=raw.get("target")
    if target not in TARGETS: return terr("INVALID_TARGET","$.target","invalid")
    ps=[]; scan_privacy(raw,"$",ps)
    if ps: return terr("FORBIDDEN_PRIVACY_FIELD",sorted(ps,key=asc)[0],target)
    ce=closed_error(raw,"translation")
    if ce: return terr(ce["code"],ce["field_path"],target)
    if raw.get("translation_version")!=TV: return terr("INVALID_TRANSLATION_INPUT","$.translation_version",target)
    p,cs,es=profile(raw.get("source_profile"),"$.source_profile",True)
    if es: e=es[0]; return terr(e["code"],e["field_path"],target)
    se=semantic(p,cs,t,"$.source_profile")
    if se: e=se[0]; return terr(e["code"],e["field_path"],target)
    ee=ext_translation(raw)
    if ee:
        group=[x for x in ee if x["code"]=="INVALID_EXTENSION_CONTAINER"] or ee; e=sorted(group,key=lambda x:asc(x["field_path"]))[0]; return terr(e["code"],e["field_path"],target)
    p,cs,_=profile(raw.get("source_profile"),"$.source_profile",False)
    if not template(raw.get("launch_template")): return terr("INVALID_TRANSLATION_INPUT","$.launch_template",target)
    if raw.get("cwd_policy") not in {"target-default-unknown","host-selected","explicit-reviewed","not-represented"}: return terr("INVALID_TRANSLATION_INPUT","$.cwd_policy",target)
    fs,source_fs,e=features(raw.get("features"),"$.features")
    if e: return terr(e["code"],e["field_path"],target)
    rs,e=refs(raw.get("provenance_refs"),"$.provenance_refs",source_fs)
    if e: return terr(e["code"],e["field_path"],target)
    if target in DEFERRED and raw["launch_template"]["template_id"]!="none": return terr("UNSUPPORTED_STATIC_TEMPLATE","$.launch_template",target)
    if target in DEFERRED:
        denied=[]
        for i,x in enumerate(fs):
            if x["state"]=="supported": denied.append(f"$.features[{i}].state")
        for i,x in enumerate(p["claims"]):
            if x.get("kind") in {"capability","transport","protocol"} and x.get("state")=="supported": denied.append(f"$.source_profile.claims[{i}].state")
        if denied: return terr("UNSUPPORTED_TARGET_CLAIM",sorted(denied,key=asc)[0],target)
    deferred=target in DEFERRED; pout=json.loads(json.dumps(p))
    if deferred: pout["claims"]=[]
    losses=[{"field_path":"$.launch_template","target":target,"reason_code":"static_template_unavailable","disposition":"preserved_unknown"}] if deferred else ([{"field_path":"$.cwd_policy","target":target,"reason_code":"cwd_not_represented","disposition":"omitted_by_contract"}] if target!="generic-cli-stdio" and raw["cwd_policy"]!="not-represented" else [])
    return {"translation_version":TRV,"target":target,"launch_template":{"template_id":"none","command":"none","argv_template":[]} if deferred else raw["launch_template"],"cwd_policy":"not-represented" if deferred or target!="generic-cli-stdio" else raw["cwd_policy"],"features":[] if deferred else fs,"provenance_refs":[] if deferred else rs,"profile":pout,"losses":losses,"extensions":{},"critical_extensions":[]}
def norm_losses(v):
    if not isinstance(v,list): return [],err("INVALID_TRANSLATION_RESULT","$.losses")
    out=[]; seen=set()
    for i,x in enumerate(v):
        p=f"$.losses[{i}]"
        if not is_obj(x): return [],err("INVALID_LOSS_RECORD",p)
        allowed={"field_path","target","reason_code","disposition"}
        if any(key not in allowed for key in x): return [],err("INVALID_LOSS_RECORD",p)
        candidates=[]
        if not field_path(x.get("field_path")): candidates.append(path(p,"field_path"))
        if x.get("target") not in TARGETS: candidates.append(path(p,"target"))
        if x.get("reason_code") not in LOSS_REASONS: candidates.append(path(p,"reason_code"))
        if x.get("disposition") not in LOSS_DISPOSITIONS: candidates.append(path(p,"disposition"))
        if candidates: return [],err("INVALID_LOSS_RECORD",sorted(candidates,key=asc)[0])
        normalized={"field_path":x["field_path"],"target":x["target"],"reason_code":x["reason_code"],"disposition":x["disposition"]}
        key=tree(normalized)
        if key in seen: return [],err("INVALID_TRANSLATION_RESULT",p)
        seen.add(key); out.append(normalized)
    return sorted(out,key=lambda x:(asc(x["field_path"]),asc(x["target"]),asc(x["reason_code"]),asc(x["disposition"]))),None
def result_ext(raw):
    es=[]; ext(raw,"$",es); p=raw.get("profile")
    if is_obj(p):
        ext(p,"$.profile",es)
        if isinstance(p.get("claims"),list):
            for i,c in enumerate(p["claims"]):
                if is_obj(c): ext(c,f"$.profile.claims[{i}]",es)
    return es
def validate_translation_result(inp):
    raw=parsed(inp)
    if not is_obj(raw): return {"ok":False,"error":err("INVALID_TRANSLATION_RESULT","$")}
    ps=[]; scan_privacy(raw,"$",ps)
    if ps: return {"ok":False,"error":err("FORBIDDEN_PRIVACY_FIELD",sorted(ps,key=asc)[0])}
    ce=closed_error(raw,"result")
    if ce: return {"ok":False,"error":ce}
    if raw.get("translation_version")!=TRV: return {"ok":False,"error":err("INVALID_TRANSLATION_RESULT","$.translation_version")}
    if raw.get("target") not in TARGETS: return {"ok":False,"error":err("INVALID_TRANSLATION_RESULT","$.target")}
    if not is_obj(raw.get("profile")): return {"ok":False,"error":err("INVALID_TRANSLATION_RESULT","$.profile")}
    p,cs,es=profile(raw["profile"],"$.profile",True); es=sort_errors(es+contradiction_errors(p,cs,"$.profile"))
    if es: return {"ok":False,"error":es[0]}
    if not template(raw.get("launch_template")): return {"ok":False,"error":err("INVALID_TRANSLATION_RESULT","$.launch_template")}
    if raw.get("cwd_policy") not in {"target-default-unknown","host-selected","explicit-reviewed","not-represented"}: return {"ok":False,"error":err("INVALID_TRANSLATION_RESULT","$.cwd_policy")}
    fs,source_fs,e=features(raw.get("features"),"$.features")
    if e: return {"ok":False,"error":{"code":"INVALID_TRANSLATION_RESULT","field_path":e["field_path"]}}
    rs,e=refs(raw.get("provenance_refs"),"$.provenance_refs",source_fs)
    if e: return {"ok":False,"error":{"code":e["code"] if e["code"]=="DUPLICATE_SET_MEMBER" else "INVALID_TRANSLATION_RESULT","field_path":e["field_path"]}}
    ls,e=norm_losses(raw.get("losses"))
    if e: return {"ok":False,"error":e}
    es=result_ext(raw)
    if es:
        group=[x for x in es if x["code"]=="INVALID_EXTENSION_CONTAINER"] or es; e=sorted(group,key=lambda x:asc(x["field_path"]))[0]; return {"ok":False,"error":e}
    normalized_profile,_,_=profile(raw["profile"],"$.profile",False)
    norm={"translation_version":TRV,"target":raw["target"],"launch_template":raw["launch_template"],"cwd_policy":raw["cwd_policy"],"features":fs,"provenance_refs":rs,"profile":normalized_profile,"losses":ls,"extensions":{},"critical_extensions":[]}
    return {"ok":True,"value":{"validation_version":TRVV,"normalized_result":norm}}
def render_conformance(result,registry):
    raw=parsed(result); target=raw.get("target") if is_obj(raw) and raw.get("target") in TARGETS else None
    if target is None: return terr("INVALID_TARGET","$.result.target","invalid")
    r=parsed(registry)
    if not is_obj(r) or len(r)!=5 or r.get("registry_version")!=RV or not opaque(r.get("record_id")) or r.get("scope")!="offline-translation": return terr("INVALID_REGISTRY_RECORD","$.registry_record",target)
    if r.get("target") not in TARGETS: return terr("INVALID_TARGET","$.registry_record.target","invalid")
    if r["target"]!=target: return terr("INVALID_TARGET","$.registry_record.target",r["target"])
    if r.get("status") not in {"documented","static-profiled","static-config-verified","static-translation-verified"}: return terr("INVALID_SCOPE_STATUS","$.registry_record.status",target)
    return {"ok":True,"value":{"record_id":r["record_id"],"target":target,"scope":"offline-translation","status":r["status"]}}
def compare_profiles(raw,t=None):
    if not valid_time(t): return {"ok":False,"error":err("INVALID_EVALUATION_TIME","$evaluation_time_ms")}
    source=parsed(raw)
    if not isinstance(source,list): return {"ok":True,"value":{"comparison_version":"meshfleet.a2a.capability-comparison/v0.1","evaluation_time_ms":t,"valid":False,"profile_results":[],"identity_contradictions":[],"semantic_contradictions":[],"exact_duplicates":[],"errors":[{"profile_index":0,"code":"MALFORMED_CAPABILITY_PROFILE","field_path":"$"}]}}
    results=[]; errors=[]; states=[]
    for i,x in enumerate(source):
        p,cs,es=profile(x); states.append((p,cs,es))
        if es:
            results.append({"profile_index":i,"structurally_valid":False,"valid":False,"validation_error_codes":sorted({q["code"] for q in es},key=asc)}); errors += [{"profile_index":i,**q} for q in es]
        else:
            se=semantic(p,cs,t,"$"); results.append({"profile_index":i,"structurally_valid":True,"profile_id":p["profile_id"],"profile_fingerprint":fp("meshfleet.a2a.capability-profile.v1",p,"meshfleet.a2a.capability-profile.v1"),"valid":not se,"validation_error_codes":sorted({q["code"] for q in se},key=asc)})
    if errors: return {"ok":True,"value":{"comparison_version":"meshfleet.a2a.capability-comparison/v0.1","evaluation_time_ms":t,"valid":False,"profile_results":results,"identity_contradictions":[],"semantic_contradictions":[],"exact_duplicates":[],"errors":sorted(errors,key=lambda x:(x["profile_index"],asc(x["code"]),asc(x["field_path"])) )}}
    identity={}; semantic_groups={}
    for profile_index,(p,claims,_) in enumerate(states):
        for c,source_index in claims:
            identity_key=(p["issuer"]["ref"],p["subject"]["ref"],p["profile_id"],c["claim_id"],p["revision"])
            fingerprint=claim_fp(p,c)
            identity.setdefault(identity_key,{}).setdefault(fingerprint,set()).add(profile_index)
            if c.get("kind") in {"capability","transport","protocol"} and c.get("state") in {"supported","unsupported"}:
                semantic_key=tree([p["subject"]["ref"],c["kind"],c.get("capability_id",c.get("transport_id",c.get("protocol_id"))),c.get("protocol_version",""),c["applicability"]])
                group=semantic_groups.setdefault(semantic_key,{"kind":c["kind"],"supported":[],"unsupported":[]})
                occurrence={"profile_index":profile_index,"claim_index":source_index,"claim_fingerprint":fingerprint}
                group[c["state"]].append(occurrence)
    def identity_object(key):
        return {"issuer_ref":key[0],"subject_ref":key[1],"profile_id":key[2],"claim_id":key[3],"revision":key[4]}
    def identity_sort(key): return (asc(key[0]),asc(key[1]),asc(key[2]),asc(key[3]),key[4])
    identity_contradictions=[]; exact_duplicates=[]
    for key in sorted(identity,key=identity_sort):
        buckets=identity[key]
        if len(buckets)>1:
            identity_contradictions.append({"identity_key":identity_object(key),"fingerprints":[{"claim_fingerprint":fingerprint,"profile_indexes":sorted(indexes)} for fingerprint,indexes in sorted(buckets.items(),key=lambda item:asc(item[0]))]})
        for fingerprint,indexes in sorted(buckets.items(),key=lambda item:asc(item[0])):
            if len(indexes)>1: exact_duplicates.append({"identity_key":identity_object(key),"claim_fingerprint":fingerprint,"profile_indexes":sorted(indexes)})
    semantic_contradictions=[]
    for group in semantic_groups.values():
        if group["supported"] and group["unsupported"]:
            key=lambda x:(x["profile_index"],x["claim_index"])
            semantic_contradictions.append({"kind":group["kind"],"supported_occurrences":sorted(group["supported"],key=key),"unsupported_occurrences":sorted(group["unsupported"],key=key)})
    semantic_contradictions.sort(key=tree)
    return {"ok":True,"value":{"comparison_version":"meshfleet.a2a.capability-comparison/v0.1","evaluation_time_ms":t,"valid":all(x["valid"] for x in results),"profile_results":results,"identity_contradictions":identity_contradictions,"semantic_contradictions":semantic_contradictions,"exact_duplicates":exact_duplicates,"errors":[]}}
def invoke(case):
    api=case["api"]; a=case["invocation_args"]
    if api=="validate-profile": return validate_profile(a.get("raw_profile"),a.get("evaluation_time_ms"))
    if api=="compare-profiles": return compare_profiles(a.get("raw_profiles"),a.get("evaluation_time_ms"))
    if api=="translate-profile": return translate_profile(a.get("input"),a.get("evaluation_time_ms"))
    if api=="validate-translation-result": return validate_translation_result(a.get("result"))
    if api=="render-conformance": return render_conformance(a.get("result"),a.get("registry_record"))
    raise ValueError("unknown api")
def main():
    if len(sys.argv)!=3 or sys.argv[1]!="--corpus": raise SystemExit("usage: --corpus PATH")
    with open(sys.argv[2],encoding="utf8") as handle: corpus=json.load(handle)
    outcomes=[]; failures=[]
    for case in corpus:
        actual=invoke(case); outcomes.append({"case_id":case["case_id"],"actual":actual,"actual_json":json.dumps(actual,separators=(",",":"),ensure_ascii=False)})
        if actual!=case["expected"]: failures.append(case["case_id"])
    print(json.dumps({"ok":not failures,"case_count":len(corpus),"outcomes":outcomes,"failures":failures},separators=(",",":"),sort_keys=True))
    raise SystemExit(0 if not failures else 1)
if __name__=="__main__": main()
