import re,os,subprocess
def show(p):
    r=subprocess.run(["git","show","HEAD:"+p],capture_output=True,text=True)
    return r.stdout if r.returncode==0 else None
closure=[l.split()[0] for l in open("/tmp/closure.txt")]
M={}
for f in closure:
    d,b=os.path.split(f)
    if f.startswith("lib/ct-"): M[f]=f"lib/t-{b[3:]}"
    elif f.startswith("app/ct-") and f!="app/ct-data-sync.tsx": M[f]=f"app/t-{b[3:]}"
    elif f.startswith("app/api/invest/ct/"): M[f]=f.replace("app/api/invest/ct/","app/api/invest/t/")
for f in subprocess.run(["git","ls-tree","--name-only","HEAD","lib/"],capture_output=True,text=True).stdout.split():
    if os.path.basename(f).startswith("ct-"): M[f]=f"lib/t-{os.path.basename(f)[3:]}"
M["lib/strategy-generation.ts"]="lib/t-generation.ts"
M["lib/strategy-generation-store.ts"]="lib/t-generation-store.ts"
M["lib/strategy-generation-types.ts"]="lib/t-generation-types.ts"
M["lib/strategy-generation-llm.ts"]="lib/t-generation-llm.ts"
M["lib/strategy-generation-models.ts"]="lib/t-generation-models.ts"
def resolve(frm,spec):
    if spec.startswith("@/"): base=spec[2:]
    elif spec.startswith("."): base=os.path.normpath(os.path.join(os.path.dirname(frm),spec))
    else: return None
    for ext in ["",".ts",".tsx",".mjs"]:
        if base+ext in M or show(base+ext) is not None and re.search(r"\.(tsx?|mjs)$",base+ext): return base+ext, ext
    return None
def rewrite(frm,src,dst):
    def sub(m):
        q=m.group(2); r=resolve(frm,q)
        if not r or r[0] not in M: return m.group(0)
        target=M[r[0]]; ext=r[1]
        tt=target[:-len(ext)] if ext else target
        if q.startswith("@/"): new="@/"+tt
        else:
            new=os.path.relpath(tt,os.path.dirname(dst))
            if not new.startswith("."): new="./"+new
        return m.group(1)+new+m.group(3)
    s=re.sub(r"""((?:from|import)\s*\(?\s*["'])([^"']+)(["'])""",sub,src)
    return s
for f,t in M.items():
    s=show(f)
    if s is None: continue
    s=rewrite(f,s,t)
    s=re.sub(r"\bct_(?=[a-z])","t_",s)
    for a in ["strategy_generation_runs","strategy_generation_meters","strategy_generation_data"]:
        s=s.replace(a,a.replace("strategy_generation","t_generation"))
    s=s.replace("/api/invest/ct","/api/invest/t")
    os.makedirs(os.path.dirname(t),exist_ok=True)
    open(t,"w").write(s)
print(len(M))
