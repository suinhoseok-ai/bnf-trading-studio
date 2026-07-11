// ===== 한국투자증권(KIS) Open API 어댑터 =====
// https://apiportal.koreainvestment.com — 실전/모의투자 모두 지원.
// 토큰은 1분당 1회 발급 제한이 있으므로 반드시 캐시(persist 콜백)를 사용한다.
import type {
  BrokerAdapter, BrokerCredentials, TokenCache, TokenPersist,
  AccountSummary, BrokerPosition, OrderRecord, PlaceOrderResult,
} from './types';
import { BrokerError, toKrCode } from './types';

const BASE = {
  real: 'https://openapi.koreainvestment.com:9443',
  paper: 'https://openapivts.koreainvestment.com:29443',
};

// tr_id: [실전, 모의]
const TR = {
  buy: { real: 'TTTC0802U', paper: 'VTTC0802U' },
  sell: { real: 'TTTC0801U', paper: 'VTTC0801U' },
  balance: { real: 'TTTC8434R', paper: 'VTTC8434R' },
  dailyOrders: { real: 'TTTC8001R', paper: 'VTTC8001R' },
  cancel: { real: 'TTTC0803U', paper: 'VTTC0803U' },
  price: { real: 'FHKST01010100', paper: 'FHKST01010100' },
};

const n = (v: unknown): number => {
  const x = Number(v);
  return isFinite(x) ? x : 0;
};

export class KISAdapter implements BrokerAdapter {
  readonly broker = 'kis' as const;
  private base: string;
  private token: TokenCache;

  constructor(
    private creds: BrokerCredentials,
    tokenCache: TokenCache,
    private persistToken: TokenPersist,
  ) {
    this.base = BASE[creds.mode];
    this.token = tokenCache ?? {};
  }

  async connect(): Promise<void> {
    // 캐시 토큰이 10분 이상 남아 있으면 재사용
    if (this.token.access_token && (this.token.expires_at ?? 0) - Date.now() > 10 * 60_000) return;
    const res = await fetch(`${this.base}/oauth2/tokenP`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'client_credentials', appkey: this.creds.appKey, appsecret: this.creds.appSecret }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.access_token) {
      throw new BrokerError(`KIS 토큰 발급 실패: ${j.error_description ?? j.msg1 ?? `HTTP ${res.status}`}`);
    }
    this.token = { access_token: j.access_token, expires_at: Date.now() + (n(j.expires_in) || 86400) * 1000 - 60_000 };
    await this.persistToken(this.token);
  }

  private headers(trId: string): Record<string, string> {
    return {
      'Content-Type': 'application/json; charset=utf-8',
      authorization: `Bearer ${this.token.access_token}`,
      appkey: this.creds.appKey,
      appsecret: this.creds.appSecret,
      tr_id: trId,
      custtype: 'P',
    };
  }

  private async get(path: string, trId: string, params: Record<string, string>) {
    const qs = new URLSearchParams(params).toString();
    const res = await fetch(`${this.base}${path}?${qs}`, { headers: this.headers(trId) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new BrokerError(`KIS ${path} HTTP ${res.status}: ${j.msg1 ?? ''}`);
    if (j.rt_cd !== undefined && j.rt_cd !== '0') throw new BrokerError(`KIS ${path}: ${j.msg1 ?? j.msg_cd ?? 'rt_cd=' + j.rt_cd}`);
    return j;
  }

  private async post(path: string, trId: string, body: Record<string, string>) {
    const res = await fetch(`${this.base}${path}`, {
      method: 'POST',
      headers: this.headers(trId),
      body: JSON.stringify(body),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new BrokerError(`KIS ${path} HTTP ${res.status}: ${j.msg1 ?? ''}`);
    return j;
  }

  private balanceParams(): Record<string, string> {
    return {
      CANO: this.creds.accountNo,
      ACNT_PRDT_CD: this.creds.accountProductCd,
      AFHR_FLPR_YN: 'N', OFL_YN: '', INQR_DVSN: '02', UNPR_DVSN: '01',
      FUND_STTL_ICLD_YN: 'N', FNCG_AMT_AUTO_RDPT_YN: 'N', PRCS_DVSN: '00',
      CTX_AREA_FK100: '', CTX_AREA_NK100: '',
    };
  }

  async getAccount(): Promise<AccountSummary> {
    const j = await this.get('/uapi/domestic-stock/v1/trading/inquire-balance', TR.balance[this.creds.mode], this.balanceParams());
    const o2 = Array.isArray(j.output2) ? j.output2[0] ?? {} : j.output2 ?? {};
    const positions = (j.output1 ?? []).filter((p: Record<string, unknown>) => n(p.hldg_qty) > 0);
    const totalAsset = n(o2.tot_evlu_amt);
    const cash = n(o2.dnca_tot_amt);
    const evalAmount = n(o2.scts_evlu_amt) || n(o2.evlu_amt_smtl_amt);
    const pnl = n(o2.evlu_pfls_smtl_amt);
    const purchase = n(o2.pchs_amt_smtl_amt);
    return {
      totalAsset, cash, evalAmount, pnl,
      pnlPct: purchase > 0 ? (pnl / purchase) * 100 : 0,
      positionCount: positions.length,
    };
  }

  async getPositions(): Promise<BrokerPosition[]> {
    const j = await this.get('/uapi/domestic-stock/v1/trading/inquire-balance', TR.balance[this.creds.mode], this.balanceParams());
    return (j.output1 ?? [])
      .filter((p: Record<string, unknown>) => n(p.hldg_qty) > 0)
      .map((p: Record<string, unknown>) => ({
        symbol: String(p.pdno ?? ''),
        name: String(p.prdt_name ?? ''),
        qty: n(p.hldg_qty),
        sellableQty: n(p.ord_psbl_qty),
        avgPrice: n(p.pchs_avg_pric),
        curPrice: n(p.prpr),
        evalAmount: n(p.evlu_amt),
        pnl: n(p.evlu_pfls_amt),
        pnlPct: n(p.evlu_pfls_rt),
      }));
  }

  async getOrders(days = 7): Promise<OrderRecord[]> {
    const end = new Date();
    const start = new Date(end.getTime() - days * 86400_000);
    const ymd = (d: Date) =>
      `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    const j = await this.get('/uapi/domestic-stock/v1/trading/inquire-daily-ccld', TR.dailyOrders[this.creds.mode], {
      CANO: this.creds.accountNo,
      ACNT_PRDT_CD: this.creds.accountProductCd,
      INQR_STRT_DT: ymd(start), INQR_END_DT: ymd(end),
      SLL_BUY_DVSN_CD: '00', INQR_DVSN: '00', PDNO: '', CCLD_DVSN: '00',
      ORD_GNO_BRNO: '', ODNO: '', INQR_DVSN_3: '00', INQR_DVSN_1: '',
      CTX_AREA_FK100: '', CTX_AREA_NK100: '',
    });
    return (j.output1 ?? []).map((o: Record<string, unknown>) => ({
      orderNo: String(o.odno ?? ''),
      date: String(o.ord_dt ?? ''),
      time: String(o.ord_tmd ?? ''),
      symbol: String(o.pdno ?? ''),
      name: String(o.prdt_name ?? ''),
      side: String(o.sll_buy_dvsn_cd_name ?? ''),
      qty: n(o.ord_qty),
      filledQty: n(o.tot_ccld_qty),
      orderPrice: n(o.ord_unpr),
      avgFillPrice: n(o.avg_prvs),
      status: n(o.tot_ccld_qty) >= n(o.ord_qty) && n(o.ord_qty) > 0 ? '체결' : n(o.tot_ccld_qty) > 0 ? '부분체결' : '미체결',
    }));
  }

  async getMarketPrice(symbol: string): Promise<number> {
    const j = await this.get('/uapi/domestic-stock/v1/quotations/inquire-price', TR.price[this.creds.mode], {
      FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: toKrCode(symbol),
    });
    return n(j.output?.stck_prpr);
  }

  private async order(kind: 'buy' | 'sell', symbol: string, qty: number, price = 0): Promise<PlaceOrderResult> {
    if (qty < 1) return { ok: false, message: '주문 수량은 1주 이상이어야 합니다.' };
    const j = await this.post('/uapi/domestic-stock/v1/trading/order-cash', TR[kind][this.creds.mode], {
      CANO: this.creds.accountNo,
      ACNT_PRDT_CD: this.creds.accountProductCd,
      PDNO: toKrCode(symbol),
      ORD_DVSN: price > 0 ? '00' : '01', // 00=지정가, 01=시장가
      ORD_QTY: String(Math.floor(qty)),
      ORD_UNPR: price > 0 ? String(Math.floor(price)) : '0',
    });
    if (j.rt_cd !== '0') return { ok: false, message: `${j.msg1 ?? '주문 실패'} (${j.msg_cd ?? ''})` };
    return { ok: true, orderNo: String(j.output?.ODNO ?? j.output?.odno ?? ''), message: j.msg1 };
  }

  placeBuyOrder(symbol: string, qty: number, price = 0) { return this.order('buy', symbol, qty, price); }
  placeSellOrder(symbol: string, qty: number, price = 0) { return this.order('sell', symbol, qty, price); }

  async cancelOrder(orderNo: string, symbol: string, qty: number): Promise<PlaceOrderResult> {
    const j = await this.post('/uapi/domestic-stock/v1/trading/order-rvsecncl', TR.cancel[this.creds.mode], {
      CANO: this.creds.accountNo,
      ACNT_PRDT_CD: this.creds.accountProductCd,
      KRX_FWDG_ORD_ORGNO: '',
      ORGN_ODNO: orderNo,
      ORD_DVSN: '01',
      RVSE_CNCL_DVSN_CD: '02', // 02=취소
      ORD_QTY: String(Math.floor(qty)),
      ORD_UNPR: '0',
      QTY_ALL_ORD_YN: 'Y',
    });
    if (j.rt_cd !== '0') return { ok: false, message: j.msg1 ?? '취소 실패' };
    return { ok: true, orderNo: String(j.output?.ODNO ?? orderNo), message: j.msg1 };
  }
}
