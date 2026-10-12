import { sessions } from './ct-calendar-data.ts';
export const CT_CALENDAR_VERSION = 'XNYS-exchange-calendars-4.11.2-2020-2035';
export const CT_CALENDAR_SOURCES = ['https://www.nyse.com/trade/hours-calendars','https://github.com/gerrymanoim/exchange_calendars'];
export function ctStockSession(date:string){
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||date<'2020-01-01'||date>'2035-12-31')throw new Error('검증된 CT 주식 캘린더 범위(2020–2035) 밖');
 return sessions[date] ?? null;
}
