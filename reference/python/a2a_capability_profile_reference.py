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
def field_path(v): return isinstance(v,str) and (v == "$evaluation_time_ms" or re.fullmatch(r"\$(?:\.[a-z][a-z0-9_]*|\[[0-9]+\])*",v) is not None)
def sort_errors(items): return sorted(items,key=lambda x:(asc(x["code"]),asc(x["field_path"])))
def path(base,k): return base+"."+k
def parsed(v):
    if not isinstance(v,str): return v
    try: return json.loads(v)
    except Exception: return None
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
        if key not in allowed: errors.append(err("FORBIDDEN_COMPUTED_FIELD" if computed and key in COMPUTED else "UNKNOWN_CORE_FIELD",base))
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
def norm_claim(v,base,errors,defer):
    if not is_obj(v): errors.append(err("INVALID_CLAIM_SCHEMA",base)); return None
    common=["claim_id","kind","applicability","provenance","issued_at_ms","expires_at_ms","extensions","critical_extensions"]
    required(v,common,base,errors,"INVALID_CLAIM_SCHEMA")
    if not claim_id(v.get("claim_id")): errors.append(err("INVALID_CLAIM_SCHEMA",path(base,"claim_id")))
    kind=v.get("kind") if v.get("kind") in {"capability","transport","protocol","runtime","provider","model"} else "capability"
    if v.get("kind") not in {"capability","transport","protocol","runtime","provider","model"}: errors.append(err("INVALID_CLAIM_KIND",path(base,"kind")))
    specific={"capability":["capability_id","state"],"transport":["transport_id","state"],"protocol":["protocol_id","protocol_version","state"],"runtime":["runtime_label"],"provider":["provider_label"],"model":["model_label"]}[kind]
    unknown(v,common+["proof"]+specific,base,errors,True)
    if not valid_time(v.get("issued_at_ms")) or not valid_time(v.get("expires_at_ms")) or (valid_time(v.get("issued_at_ms")) and valid_time(v.get("expires_at_ms")) and v["issued_at_ms"]>=v["expires_at_ms"]): errors.append(err("INVALID_TIME_WINDOW",path(base,"expires_at_ms")))
    app=norm_app(v.get("applicability"),path(base,"applicability"),errors)
    prov=v.get("provenance")
    if not is_obj(prov) or prov.get("level") not in {"advertised","reported","observed","attested"}: errors.append(err("INVALID_PROVENANCE",path(base,"provenance"))); provn={"level":"advertised"}
    else:
        level=prov["level"]; req={"advertised":["level"],"reported":["level","issuer_ref"],"observed":["level","issuer_ref","observed_at_ms","probe_ref"],"attested":["level","issuer_ref"]}[level]
        required(prov,req,path(base,"provenance"),errors,"INVALID_PROVENANCE"); unknown(prov,req,path(base,"provenance"),errors)
        if level!="advertised" and not opaque(prov.get("issuer_ref")): errors.append(err("INVALID_PROVENANCE",path(base,"provenance.issuer_ref")))
        provn={k:prov[k] for k in req if k in prov}
    if not defer: ext(v,base,errors)
    out={"claim_id":v.get("claim_id"),"kind":kind,"applicability":app,"provenance":provn,"issued_at_ms":v.get("issued_at_ms"),"expires_at_ms":v.get("expires_at_ms"),"extensions":v.get("extensions"),"critical_extensions":v.get("critical_extensions")}
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
    required(raw,keys,base,errors,"MALFORMED_CAPABILITY_PROFILE"); unknown(raw,keys,base,errors,True)
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
    if not errors: claims.sort(key=lambda x:tree(x[0]))
    return {"profile_version":raw.get("profile_version"),"profile_id":raw.get("profile_id"),"revision":raw.get("revision"),"issuer":raw.get("issuer"),"subject":raw.get("subject"),"issued_at_ms":raw.get("issued_at_ms"),"expires_at_ms":raw.get("expires_at_ms"),"claims":[x[0] for x in claims],"extensions":raw.get("extensions"),"critical_extensions":raw.get("critical_extensions")},claims,sort_errors(errors)
def claim_fp(p,c): return fp("meshfleet.a2a.capability-claim.v1",[p["issuer"]["ref"],p["subject"]["ref"],p["profile_id"],c["claim_id"],p["revision"],c],"meshfleet.a2a.capability-claim.v1")
def semantic(p,claims,t,base):
    es=[]
    if t<p["issued_at_ms"]: es.append(err("NOT_YET_VALID_PROFILE",path(base,"issued_at_ms")))
    if t>=p["expires_at_ms"]: es.append(err("EXPIRED_PROFILE",path(base,"expires_at_ms")))
    for c,i in claims:
        if t<c["issued_at_ms"]: es.append(err("NOT_YET_VALID_CLAIM",f"{base}.claims[{i}].issued_at_ms"))
        if t>=c["expires_at_ms"]: es.append(err("EXPIRED_CLAIM",f"{base}.claims[{i}].expires_at_ms"))
    return sort_errors(es)
def validate_profile(raw,t=None):
    if not valid_time(t): return {"ok":False,"error":err("INVALID_EVALUATION_TIME","$evaluation_time_ms")}
    p,cs,es=profile(raw)
    if es: return {"ok":True,"value":{"validation_version":VV,"evaluation_time_ms":t,"valid":False,"proof_results":[],"errors":es}}
    errors=semantic(p,cs,t,"$"); proof=[{"claim_id":c["claim_id"],"claim_fingerprint":claim_fp(p,c),"verification_status":"absent"} for c,i in cs]
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
    if not isinstance(v,list) or len(v)>64: return [],err("INVALID_TRANSLATION_INPUT",base)
    out=[]; seen=set()
    for i,x in enumerate(v):
        q=f"{base}[{i}]"
        if not is_obj(x) or len(x)!=3 or not canonical_id(x.get("feature_id")) or x.get("state") not in {"supported","unsupported","unknown","not-represented"} or not opaque(x.get("provenance_ref")):
            return [],err("INVALID_TRANSLATION_INPUT",q if not is_obj(x) else path(q,"feature_id") if not canonical_id(x.get("feature_id")) else path(q,"state") if x.get("state") not in {"supported","unsupported","unknown","not-represented"} else path(q,"provenance_ref"))
        if x["feature_id"] in seen: return [],err("INVALID_TRANSLATION_INPUT",path(q,"feature_id"))
        seen.add(x["feature_id"]); out.append(dict(x))
    return sorted(out,key=tree),None
def refs(v,base,fs):
    if not isinstance(v,list) or len(v)>64: return [],err("INVALID_TRANSLATION_INPUT",base)
    seen=set(); out=[]
    for i,x in enumerate(v):
        if not opaque(x): return [],err("INVALID_TRANSLATION_INPUT",f"{base}[{i}]")
        if x in seen: return [],err("DUPLICATE_SET_MEMBER",f"{base}[{i}]")
        seen.add(x); out.append(x)
    for f in fs:
        if f["provenance_ref"] not in seen: return [],err("INVALID_TRANSLATION_INPUT","$.features[0].provenance_ref")
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
    keys={"translation_version","target","source_profile","launch_template","cwd_policy","features","provenance_refs","extensions","critical_extensions"}
    if any(k not in keys for k in raw): return terr("UNKNOWN_CORE_FIELD","$",target)
    if raw.get("translation_version")!=TV: return terr("INVALID_TRANSLATION_INPUT","$.translation_version",target)
    p,cs,es=profile(raw.get("source_profile"),"$.source_profile",True)
    if es: e=es[0]; return terr(e["code"],e["field_path"],target)
    se=semantic(p,cs,t,"$.source_profile")
    if se: e=se[0]; return terr(e["code"],e["field_path"],target)
    ee=ext_translation(raw)
    if ee:
        group=[x for x in ee if x["code"]=="INVALID_EXTENSION_CONTAINER"] or ee; e=sorted(group,key=lambda x:asc(x["field_path"]))[0]; return terr(e["code"],e["field_path"],target)
    if not template(raw.get("launch_template")): return terr("INVALID_TRANSLATION_INPUT","$.launch_template",target)
    if raw.get("cwd_policy") not in {"target-default-unknown","host-selected","explicit-reviewed","not-represented"}: return terr("INVALID_TRANSLATION_INPUT","$.cwd_policy",target)
    fs,e=features(raw.get("features"),"$.features")
    if e: return terr(e["code"],e["field_path"],target)
    rs,e=refs(raw.get("provenance_refs"),"$.provenance_refs",fs)
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
        if not is_obj(x) or len(x)!=4 or not field_path(x.get("field_path")) or x.get("target") not in TARGETS or x.get("reason_code") not in LOSS_REASONS or x.get("disposition") not in LOSS_DISPOSITIONS: return [],err("INVALID_LOSS_RECORD",p if not is_obj(x) or len(x)!=4 else path(p,"field_path") if not field_path(x.get("field_path")) else path(p,"target") if x.get("target") not in TARGETS else path(p,"reason_code") if x.get("reason_code") not in LOSS_REASONS else path(p,"disposition"))
        key=json.dumps(x,separators=(",",":"),sort_keys=True)
        if key in seen: return [],err("INVALID_TRANSLATION_RESULT",p)
        seen.add(key); out.append(dict(x))
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
    for k in raw:
        if k in COMPUTED: return {"ok":False,"error":err("FORBIDDEN_COMPUTED_FIELD",path("$",k))}
    keys={"translation_version","target","launch_template","cwd_policy","features","provenance_refs","profile","losses","extensions","critical_extensions"}
    if any(k not in keys for k in raw): return {"ok":False,"error":err("UNKNOWN_CORE_FIELD","$")}
    if raw.get("translation_version")!=TRV: return {"ok":False,"error":err("INVALID_TRANSLATION_RESULT","$.translation_version")}
    if raw.get("target") not in TARGETS: return {"ok":False,"error":err("INVALID_TRANSLATION_RESULT","$.target")}
    if not is_obj(raw.get("profile")): return {"ok":False,"error":err("INVALID_TRANSLATION_RESULT","$.profile")}
    p,cs,es=profile(raw["profile"],"$.profile",True)
    if es: return {"ok":False,"error":es[0]}
    if not template(raw.get("launch_template")): return {"ok":False,"error":err("INVALID_TRANSLATION_RESULT","$.launch_template")}
    if raw.get("cwd_policy") not in {"target-default-unknown","host-selected","explicit-reviewed","not-represented"}: return {"ok":False,"error":err("INVALID_TRANSLATION_RESULT","$.cwd_policy")}
    fs,e=features(raw.get("features"),"$.features")
    if e: return {"ok":False,"error":{"code":"INVALID_TRANSLATION_RESULT","field_path":e["field_path"]}}
    rs,e=refs(raw.get("provenance_refs"),"$.provenance_refs",fs)
    if e: return {"ok":False,"error":{"code":e["code"] if e["code"]=="DUPLICATE_SET_MEMBER" else "INVALID_TRANSLATION_RESULT","field_path":e["field_path"]}}
    ls,e=norm_losses(raw.get("losses"))
    if e: return {"ok":False,"error":e}
    es=result_ext(raw)
    if es:
        group=[x for x in es if x["code"]=="INVALID_EXTENSION_CONTAINER"] or es; e=sorted(group,key=lambda x:asc(x["field_path"]))[0]; return {"ok":False,"error":e}
    norm={"translation_version":TRV,"target":raw["target"],"launch_template":raw["launch_template"],"cwd_policy":raw["cwd_policy"],"features":fs,"provenance_refs":rs,"profile":p,"losses":ls,"extensions":{},"critical_extensions":[]}
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
    return {"ok":True,"value":{"comparison_version":"meshfleet.a2a.capability-comparison/v0.1","evaluation_time_ms":t,"valid":all(x["valid"] for x in results),"profile_results":results,"identity_contradictions":[],"semantic_contradictions":[],"exact_duplicates":[],"errors":[]}}
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
        actual=invoke(case); outcomes.append({"case_id":case["case_id"],"actual":actual})
        if actual!=case["expected"]: failures.append(case["case_id"])
    print(json.dumps({"ok":not failures,"case_count":len(corpus),"outcomes":outcomes,"failures":failures},separators=(",",":"),sort_keys=True))
    raise SystemExit(0 if not failures else 1)
if __name__=="__main__": main()
