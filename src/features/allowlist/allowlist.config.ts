export const EXECUTION_ALLOWLIST: readonly string[] = [
  'getBalance',
  'getMidMarketRate',
  'createQuote',
  'createBalanceConversion',
  'getBalanceConversions',

  'validateBankAccount',
  'getBankAccountValidations',

  'createCustomer',
  'getCustomers',
  'getCustomerById',
  'updateCustomer',
  'createCustomerBankAccount',
  'getCustomerBankAccounts',

  'getDocuments',
  'getDocumentById',

  'getLrsBanks',
  'createLrsCustomerBankAccount',
  'createLrsQuote',

  'listKycLinks',
  'createKycLink',
  'getKycLinkById',
  'createInvestorJourney',

  'createOrder',
  'getOrders',
  'getOrderById',
  'updateOrderRfi',

  'createPayin',
  'getPayins',
  'getPayinById',
  'updatePayin',
  'cancelPayin',
  'updatePayinRfi',
  'mockReviewPaymentLink',

  'createPayment',
  'getPayments',
  'getPaymentById',
  'createPaymentSession',
  'connectPayin',
  'getEligiblePayins',
  'createMockPayment',
  'mockUpdatePaymentFundsAvailable',

  'createPayout',
  'getPayouts',
  'getPayoutById',
  'cancelPayout',
  'mockUpdatePayoutStatus',

  'createPrice',
  'getPrices',
  'getPriceById',
  'getDynamicPrices',
  'createPricingSplit',
  'getPricingSplits',

  'createRefund',
  'getRefunds',
  'getRefundById',
  'mockUpdateRefund',

  'getRfis',
  'getRfi',
  'respondRfi',

  'createSettlement',
  'getSettlements',
  'getSettlementById',
  'getTransactionsLinkedToSettlement',
  'triggerMockSettlement',

  'getSubscriptions',
  'createSubscription',
  'getSubscriptionById',
  'cancelSubscription',
  'updateNextPaymentDate',
  'pauseSubscription',
  'resumeSubscription',

  'createBeneficiaryV2',
  'listBeneficiariesV2',
  'getBeneficiaryByIdV2',
  'mockReviewBeneficiaryV2',

  'createVirtualAccountV2',
  'getVirtualAccounts',
  'closeVirtualAccount',

  'createInternalTransfer',

  'getMerchant',
];

export const executionAllowlist: ReadonlySet<string> = new Set(EXECUTION_ALLOWLIST);
