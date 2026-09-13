#!/usr/bin/env python3
"""Offline-only, prespecified 16-cell intraday experiment; see protocol.md."""
import argparse, csv, json, math, random, statistics
from collections import defaultdict
from pathlib import Path
HERE = Path(__file__).resolve().parent
CACHE = HERE.parent / 'cache'
SYMBOLS = ['NVDA','AMD','TSLA','PLTR','COIN']
START, INNER, SPLIT = '2024-09-09', '2025-09-01', '2026-03-04'

def load(before=None):
    out, audit = {}, {}
    for s in SYMBOLS + ['QQQ']:
        p=CACHE / f'intraday-{s}-5m-2024-09-09-2026-09-04.json'
        raw=json.loads(p.read_text()); grouped=defaultdict(dict)
        for b in raw:
            if b['date'] < START or (before and b['date'] >= before): continue
            if '09:30' <= b['time'] < '16:00': grouped[b['date']][b['time']]=b
        sessions={}; history=[]; incomplete=0; invalid=0
        for date,bmap in sorted(grouped.items()):
            bars=sorted(bmap.values(),key=lambda b:b['timestamp'])
            if len(bars)!=78 or bars[0]['time']!='09:30' or bars[-1]['time']!='15:55' or any(bars[i]['timestamp']-bars[i-1]['timestamp']!=300 for i in range(1,len(bars))): incomplete+=1; continue
            if any(min(b['open'],b['low'],b['high'],b['close'])<=0 or b['low']>min(b['open'],b['close']) or b['high']<max(b['open'],b['close']) for b in bars): invalid+=1;continue
            ov=sum(b['volume'] for b in bars[:6]); rv=ov/statistics.median(history[-20:]) if len(history)>=20 and statistics.median(history[-20:])>0 else None
            history.append(ov); vol=notional=0; vwap=[]
            for b in bars:
                vol+=b['volume']; notional+=(b['high']+b['low']+b['close'])/3*b['volume']; vwap.append(notional/vol if vol else b['close'])
            sessions[date]={'bars':bars,'rv':rv,'vwap':vwap}
        out[s]=sessions
        audit[s]={'rawRowsInFile':len(raw),'fullSessions':len(sessions),'incompleteSessionsExcluded':incomplete,'invalidSessionsExcluded':invalid,'first':min(sessions),'last':max(sessions)}
    return out,audit

def configs():
    return [{'family':f,'window':w,'threshold':t,'rv':r,'id':f'{f}_{w}_t{t}_rv{r}'} for f in ['continuation','dip_rebound'] for w in ['morning','afternoon'] for t in [.3,.8] for r in [.8,1.3]]

def ret(a,b): return (a/b-1)*100

def run(conf,data,lo,hi=None):
    rows=[]
    for symbol in SYMBOLS:
        for date,ses in sorted(data[symbol].items()):
            if date<lo or (hi and date>=hi) or date not in data['QQQ'] or ses['rv'] is None or ses['rv']<conf['rv']: continue
            bars=ses['bars']; q=data['QQQ'][date]['bars']
            for i in range(6,66):
                time=bars[i]['time']
                if not (('10:00'<=time<='11:25') if conf['window']=='morning' else ('13:00'<=time<='14:55')): continue
                day=ret(bars[i]['close'],bars[0]['open']); qday=ret(q[i]['close'],q[0]['open'])
                last5=ret(bars[i]['close'],bars[i-1]['close']); last15=ret(bars[i]['close'],bars[i-3]['close']); last30=ret(bars[i]['close'],bars[i-6]['close']); qlast30=ret(q[i]['close'],q[i-6]['close']); prev15=ret(bars[i-1]['close'],bars[i-4]['close'])
                if conf['family']=='continuation':
                    signal=day>=conf['threshold'] and day-qday>=.3 and qday>=0 and last15>=.3 and last5>0 and bars[i]['close']>ses['vwap'][i]
                    score=day-qday
                else:
                    signal=last30<=-conf['threshold'] and qlast30>=0 and last5>=.1 and prev15<=-.3
                    score=qlast30-last30
                if not signal: continue
                j=i+1; entry=bars[j]['open']; stop=entry*.992; target=entry*1.024; exitprice=None; exitreason=None; end=min(j+11,77)
                for k in range(j,end+1):
                    b=bars[k]
                    if b['low']<=stop:
                        exitprice=min(stop,b['open']); exitreason='stop_both_touched' if b['high']>=target else ('stop_gap' if b['open']<stop else 'stop'); break
                    if b['high']>=target:
                        exitprice=target;exitreason='target';break
                    if k==end: exitprice=b['close'];exitreason='time';break
                gross=ret(exitprice,entry)
                net=(exitprice/entry*(1-.002-.00015)/(1+.002+.00015)-1)*100
                stress=(exitprice/entry*(1-.002-.0005)/(1+.002+.0005)-1)*100
                rows.append({'strategy':conf['id'],'symbol':symbol,'date':date,'signalTs':bars[i]['timestamp']+300,'entryTs':bars[j]['timestamp'],'exitTs':bars[k]['timestamp']+300,'entry':entry,'exit':exitprice,'grossPct':gross,'netPct':net,'stressNetPct':stress,'exitReason':exitreason,'score':score})
                break
    return sorted(rows,key=lambda r:(r['entryTs'],-r['score'],r['symbol']))

def calendar(data,lo,hi=None):
    return sorted(d for d in data['QQQ'] if d>=lo and (not hi or d<hi) and any(d in data[s] and data[s][d]['rv'] is not None for s in SYMBOLS))

def stats(rows,cal,bootstrap=False):
    if not rows:return {'trades':0,'sessionDays':len(cal),'noSignalDays':len(cal)}
    bydate=defaultdict(list)
    for r in rows:bydate[r['date']].append(r)
    dm=[statistics.mean(r['netPct'] for r in rs) for rs in bydate.values()]
    out={'trades':len(rows),'signalDays':len(bydate),'sessionDays':len(cal),'noSignalDays':len(set(cal)-set(bydate)),'meanGrossPct':statistics.mean(r['grossPct'] for r in rows),'meanNetPct':statistics.mean(r['netPct'] for r in rows),'meanStressNetPct':statistics.mean(r['stressNetPct'] for r in rows),'grossWinRatePct':100*sum(r['grossPct']>0 for r in rows)/len(rows),'netWinRatePct':100*sum(r['netPct']>0 for r in rows)/len(rows),'medianNetPct':statistics.median(r['netPct'] for r in rows),'meanDateClusterNetPct':statistics.mean(dm),'symbolCounts':{s:sum(r['symbol']==s for r in rows) for s in SYMBOLS},'exitReasons':{s:sum(r['exitReason']==s for r in rows) for s in sorted(set(r['exitReason'] for r in rows))}}
    if bootstrap:
        rng=random.Random(4909); means=sorted(statistics.mean(rng.choices(dm,k=len(dm))) for _ in range(3000))
        out['dateClusterBootstrapMeanNet95Pct']=[means[74],means[2924]]
    return out

def train():
    data,audit=load(before=SPLIT);grid=[]; cache={}
    for conf in configs():
        rows=run(conf,data,START,SPLIT); cache[conf['id']]=rows
        dev=[r for r in rows if r['date']<INNER]; val=[r for r in rows if r['date']>=INNER]
        elig=len(rows)>=80 and len(dev)>=40 and len(val)>=30
        grid.append({'config':conf,'eligible':elig,'development':stats(dev,calendar(data,START,INNER)),'innerValidation':stats(val,calendar(data,INNER,SPLIT)),'training':stats(rows,calendar(data,START,SPLIT))})
    selected=[]
    for fam in ['continuation','dip_rebound']:
        cells=[g for g in grid if g['eligible'] and g['config']['family']==fam]
        cells.sort(key=lambda g:(-g['innerValidation']['meanDateClusterNetPct'],g['config']['rv'],g['config']['threshold'],0 if g['config']['window']=='morning' else 1))
        if cells:selected.append(cells[0]['config'])
    (HERE/'frozen.json').write_text(json.dumps({'note':'Frozen using training and inner validation only; no holdout return inspection in train mode','selected':selected},indent=2))
    allrows=[r for conf in selected for r in cache[conf['id']]]
    (HERE/'training-trades.json').write_text(json.dumps(allrows,indent=2))
    (HERE/'training-report.json').write_text(json.dumps({'audit':audit,'grid':grid,'selected':[{'config':conf,'training':stats(cache[conf['id']],calendar(data,START,SPLIT),True)} for conf in selected]},indent=2))
    print(json.dumps({'selected':selected,'gridBrief':[{'id':g['config']['id'],'eligible':g['eligible'],'N':g['training']['trades'],'devN':g['development']['trades'],'valN':g['innerValidation']['trades'],'ISnet':g['training'].get('meanNetPct'),'VALnet':g['innerValidation'].get('meanDateClusterNetPct')} for g in grid]},indent=2))

def holdout():
    if (HERE/'holdout-report.json').exists():raise SystemExit('Refusing repeated holdout evaluation; inspect saved output.')
    frozen=json.loads((HERE/'frozen.json').read_text());data,audit=load();results=[];allrows=[]
    for conf in frozen['selected']:
        rows=run(conf,data,SPLIT);allrows+=rows
        results.append({'config':conf,'holdout':stats(rows,calendar(data,SPLIT),True)})
    (HERE/'holdout-trades.json').write_text(json.dumps(allrows,indent=2))
    (HERE/'holdout-report.json').write_text(json.dumps({'warning':'Historical holdout reused in previous project research, NOT pristine','audit':audit,'results':results},indent=2))
    trainrows=json.loads((HERE/'training-trades.json').read_text());combined=sorted(trainrows+allrows,key=lambda r:(r['entryTs'],r['strategy'],r['symbol']))
    (HERE/'trades.json').write_text(json.dumps(combined,indent=2))
    if combined:
        with (HERE/'trades.csv').open('w') as f:
            writer=csv.DictWriter(f,fieldnames=list(combined[0]));writer.writeheader();writer.writerows(combined)
    print(json.dumps(results,indent=2))

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('mode',choices=['train','holdout']);a=p.parse_args();train() if a.mode=='train' else holdout()
