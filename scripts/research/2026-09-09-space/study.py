"""Read-only market study. All generated files remain inside this research directory."""
import json, math, statistics, collections, datetime, zoneinfo
from pathlib import Path
P=Path(__file__).parent
NY=zoneinfo.ZoneInfo('America/New_York')
STEP=300

def convert(b):
 t=b.get('timestamp',b.get('t',0)//1000)
 dt=datetime.datetime.fromtimestamp(t,NY)
 return dict(timestamp=t,date=dt.strftime('%Y-%m-%d'),time=dt.strftime('%H:%M'),open=b.get('open',b.get('o')),high=b.get('high',b.get('h')),low=b.get('low',b.get('l')),close=b.get('close',b.get('c')),volume=b.get('volume',b.get('v')))

def read(sym):
 path=P/('intraday-'+sym+'.json') if sym!='QQQ' else P.parent/'cache/intraday-QQQ-5m-2024-09-09-2026-09-04.json'
 rows=[convert(b) for b in json.load(open(path))]
 rows=[b for b in rows if '2026-06-12'<=b['date']<='2026-09-04']
 return {b['timestamp']:b for b in rows}

DATA={s:read(s) for s in ['SPCX','RKLB','ASTS','QQQ']}
SYNC=sorted(set.intersection(*[set(m) for m in DATA.values()]))
SYNC=[t for t in SYNC if '09:30'<=DATA['QQQ'][t]['time']<'16:00']
DAYS=sorted({DATA['QQQ'][t]['date'] for t in SYNC if sum(1 for z in SYNC if DATA['QQQ'][z]['date']==DATA['QQQ'][t]['date'])>=60})
TRAIN=DAYS[:35];TEST=DAYS[35:]
GROUP={d:('train' if d in TRAIN else 'validation') for d in DAYS}
coverage={s:dict(bars=len(m),first=min(m.values(),key=lambda x:x['timestamp']),last=max(m.values(),key=lambda x:x['timestamp']),regular_days=len({b['date'] for b in m.values() if '09:30'<=b['time']<'16:00'})) for s,m in DATA.items()}

def ret(sym,t,span=3):
 return DATA[sym][t]['close']/DATA[sym][t-(span-1)*STEP]['open']-1

def net(g,friction=.0003):
 # .2% commission per notional each side. Friction split into worse entry and exit prices.
 return (1+g)*(1-friction/2)*(1-.002)/((1+friction/2)*(1+.002))-1

def mean(a):return statistics.mean(a) if a else None

def corr(a,b):
 if len(a)<3:return None
 ma,mb=mean(a),mean(b)
 den=math.sqrt(sum((v-ma)**2 for v in a)*sum((v-mb)**2 for v in b))
 return sum((x-ma)*(y-mb) for x,y in zip(a,b))/den if den else None

def stats(trades,days,friction=.0003):
 vals=[net(x['gross'],friction) for x in trades]
 daily={d:0. for d in days}
 # This function is only used for one-trade/day series, or per-rule/follower results.
 for x,v in zip(trades,vals):daily[x['date']]+=v
 wealth=1000.;peak=1000.;mdd=0
 for d,v in daily.items():
  wealth*=1+v;peak=max(peak,wealth);mdd=min(mdd,wealth/peak-1)
 return dict(days=len(days),trades=len(trades),active_days=sum(v!=0 for v in daily.values()),gross_mean=mean([x['gross'] for x in trades]),net_mean=mean(vals),net_median=statistics.median(vals) if vals else None,net_win_rate=mean([x>0 for x in vals]),gross_win_rate=mean([x['gross']>0 for x in trades]),net_daily_geomean=(wealth/1000)**(1/len(days))-1 if days else None,ending_equity=wealth,total_net=wealth/1000-1,hit1pct_days=sum(v>=.01 for v in daily.values()),hit2pct_days=sum(v>=.02 for v in daily.values()),loss_days=sum(v<0 for v in daily.values()),no_trade_days=len(days)-len(trades),worst_day=min(daily.values()) if daily else None,max_drawdown=mdd,qqq_same_window_mean=mean([x['qqq_gross'] for x in trades]))

trades=[];seen=set();diagnostics={s:collections.defaultdict(list) for s in ['RKLB','ASTS']}
for t in SYNC:
 b=DATA['QQQ'][t];d=b['date']
 if d not in GROUP:continue
 # Complete 15-minute observation and future 60-minute hold (entry t+10m).
 ts=[t+j*STEP for j in range(-2,14)]
 if any(any(z not in DATA[s] or DATA[s][z]['date']!=d for z in ts) for s in DATA):continue
 if not ('09:45'<=b['time']<='14:45'):continue
 market=ret('QQQ',t);leader=ret('SPCX',t)-market
 for follower in ['RKLB','ASTS']:
  fr=ret(follower,t)-market
  upbar=DATA[follower][t]['close']>DATA[follower][t]['open']
  for rule,passes in [('catchup',leader>=.008 and -.005<=fr<=.0025 and leader-fr>=.0075 and upbar),('rotation',leader<=-.008 and .002<=fr<=.008 and upbar)]:
   key=(follower,rule,d)
   if not passes or key in seen:continue
   seen.add(key)
   ent=t+2*STEP
   for horizon in [30,60]:
    ex=ent+(horizon//5-1)*STEP
    p0=DATA[follower][ent]['open'];p1=DATA[follower][ex]['close']
    trades.append(dict(symbol=follower,rule=rule,horizon_min=horizon,date=d,split=GROUP[d],signal_bar_start=t,signal_time=t+STEP,entry_time=ent,exit_time=ex+STEP,signal_time_et=datetime.datetime.fromtimestamp(t+STEP,NY).isoformat(),entry_time_et=datetime.datetime.fromtimestamp(ent,NY).isoformat(),exit_time_et=datetime.datetime.fromtimestamp(ex+STEP,NY).isoformat(),entry_price=p0,exit_price=p1,gross=p1/p0-1,net=net(p1/p0-1),net_stress=net(p1/p0-1,.001),qqq_gross=DATA['QQQ'][ex]['close']/DATA['QQQ'][ent]['open']-1,leader_residual=leader,follower_residual=fr))
  # Comparable non-overlapping 15-minute changes, not execution results.
  fut=t+3*STEP
  lnext=ret('SPCX',fut)-ret('QQQ',fut)
  fnext=ret(follower,fut)-ret('QQQ',fut)
  diag=diagnostics[follower]
  diag[GROUP[d]+'_lead'].append(leader);diag[GROUP[d]+'_follow'].append(fr);diag[GROUP[d]+'_lead_next'].append(lnext);diag[GROUP[d]+'_follow_next'].append(fnext)

report=dict(spec_file='hypotheses.md',cost_model='net=(exit/entry)*(1-friction/2)*(1-.002)/((1+friction/2)*(1+.002))-1; friction=.0003 baseline,.001 stress',coverage=coverage,usable_sessions=DAYS,split=dict(train=TRAIN,validation=TEST),results=[],diagnostics={},combined=[])
for s in ['RKLB','ASTS']:
 for rule in ['catchup','rotation']:
  for h in [30,60]:
   for split,days in [('train',TRAIN),('validation',TEST)]:
    tr=[x for x in trades if x['symbol']==s and x['rule']==rule and x['horizon_min']==h and x['split']==split]
    report['results'].append(dict(symbol=s,rule=rule,horizon_min=h,split=split,baseline=stats(tr,days),stress=stats(tr,days,.001)))
 for split in ['train','validation']:
  v=diagnostics[s];a=v[split+'_lead'];b=v[split+'_follow'];an=v[split+'_lead_next'];bn=v[split+'_follow_next']
  report['diagnostics'][s+'_'+split]=dict(observations=len(a),simultaneous_corr=corr(a,b),leader_to_follower_next15m_corr=corr(a,bn),follower_to_leader_next15m_corr=corr(b,an),note='Overlapping 15-minute windows; descriptive correlations, no independent-observation p value')
for rule in ['catchup','rotation','both']:
 for split,days in [('train',TRAIN),('validation',TEST)]:
  candidates=[x for x in trades if x['horizon_min']==30 and x['split']==split and (rule=='both' or x['rule']==rule)]
  selected={}
  for x in sorted(candidates,key=lambda x:(x['entry_time'],0 if x['symbol']=='RKLB' else 1,x['rule'])):selected.setdefault(x['date'],x)
  tr=list(selected.values())
  report['combined'].append(dict(rule=rule,split=split,baseline=stats(tr,days),stress=stats(tr,days,.001),trade_ids=[dict(date=x['date'],symbol=x['symbol'],rule=x['rule'],entry_time=x['entry_time']) for x in tr]))
(P/'results.json').write_text(json.dumps(report,indent=2))
(P/'trades.json').write_text(json.dumps(trades,indent=2))
print(json.dumps(dict(split=report['split'],results=[x for x in report['results'] if x['horizon_min']==30],diagnostics=report['diagnostics'],combined=report['combined']),indent=2))
