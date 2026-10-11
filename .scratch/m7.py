import re
pat=re.compile(r"<<<<<<< HEAD\n(.*?)=======\n(.*?)>>>>>>> main\n", re.S)
p='docs/adr/0017-generic-http-adapter.md'
s=open(p).read(); s=pat.sub(lambda m: m.group(2)+"\n"+m.group(1), s); open(p,'w').write(s)
p='docs/api-verification.md'
s=open(p).read(); s=pat.sub(lambda m: m.group(2)+m.group(1).replace("| R6 |","| R7 |",1), s); open(p,'w').write(s)
p='packages/sim/src/routes/rest.ts'
s=open(p).read()
for a,b in [(" *   R6. With an `auth` seed"," *   R7. With an `auth` seed"),("credentials (R6). */","credentials (R7). */"),("for the REST sim (R6).","for the REST sim (R7)."),("/** Real credentials (R6). */","/** Real credentials (R7). */"),("/** R6: the request","/** R7: the request")]:
    assert s.count(a)==1,a; s=s.replace(a,b)
open(p,'w').write(s)
p='docs/coverage.md'
s=open(p).read(); s=pat.sub(lambda m: m.group(2), s); open(p,'w').write(s)
for p in ['site/contributing/adr/0017-generic-http-adapter.mdx','site/reference/api-verification.mdx','site/reference/coverage.mdx']:
    s=open(p).read(); s=pat.sub(lambda m: m.group(2), s); open(p,'w').write(s)
