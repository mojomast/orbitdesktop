import os,json,urllib.request,urllib.error
req=urllib.request.Request('https://api.xiaomimimo.com/v1/models',headers={'api-key':os.environ['MIMO_API_KEY']})
try:
    with urllib.request.urlopen(req,timeout=30) as r: print(json.dumps({'models':[x['id'] for x in json.load(r).get('data',[])]}))
except urllib.error.HTTPError as e: print(json.dumps({'http_status':e.code}))
