// ===== 토스증권 어댑터 (플레이스홀더) =====
// 토스증권은 현재 개인 투자자용 공개 매매 API를 제공하지 않는다.
// Broker Adapter 패턴에 맞춰 인터페이스만 구현해 두었으며,
// 토스증권이 Open API를 공개하면 이 파일만 실제 구현으로 교체하면 된다
// (자동매매 엔진·웹 화면은 수정 불필요).
import type {
  BrokerAdapter, BrokerCredentials, TokenCache, TokenPersist,
  AccountSummary, BrokerPosition, OrderRecord, PlaceOrderResult,
} from './types';
import { BrokerError } from './types';

const NOT_SUPPORTED =
  '토스증권은 아직 개인용 공개 매매 API를 제공하지 않습니다. 한국투자증권(KIS)을 선택하세요. ' +
  '(토스증권이 Open API를 공개하면 어댑터 교체만으로 지원 예정)';

export class TossAdapter implements BrokerAdapter {
  readonly broker = 'toss' as const;

  // 인터페이스 시그니처 유지를 위해 인자를 받지만 사용하지 않음
  constructor(_creds: BrokerCredentials, _token: TokenCache, _persist: TokenPersist) {
    void _creds; void _token; void _persist;
  }

  async connect(): Promise<void> { throw new BrokerError(NOT_SUPPORTED); }
  async getAccount(): Promise<AccountSummary> { throw new BrokerError(NOT_SUPPORTED); }
  async getPositions(): Promise<BrokerPosition[]> { throw new BrokerError(NOT_SUPPORTED); }
  async getOrders(): Promise<OrderRecord[]> { throw new BrokerError(NOT_SUPPORTED); }
  async getMarketPrice(): Promise<number> { throw new BrokerError(NOT_SUPPORTED); }
  async placeBuyOrder(): Promise<PlaceOrderResult> { throw new BrokerError(NOT_SUPPORTED); }
  async placeSellOrder(): Promise<PlaceOrderResult> { throw new BrokerError(NOT_SUPPORTED); }
  async cancelOrder(): Promise<PlaceOrderResult> { throw new BrokerError(NOT_SUPPORTED); }
}
