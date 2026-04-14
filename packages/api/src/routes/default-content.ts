// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

export type SupportedLang = 'en' | 'es' | 'zh';

export const DEFAULT_CONTENT: Record<
  SupportedLang,
  Record<'privacy-policy' | 'terms-of-service', string>
> = {
  en: {
    'privacy-policy': `<h1>Privacy Policy</h1>
<p>Last updated: January 1, 2025</p>

<h2>Introduction</h2>
<p>[Company Name] ("we," "our," or "us") operates an electric vehicle (EV) charging network. This Privacy Policy explains how we collect, use, and protect your personal information when you use our charging services, mobile application, and website.</p>

<h2>Information We Collect</h2>
<h3>Account Data</h3>
<p>When you create an account, we collect your name, email address, phone number, and billing information necessary to provide charging services.</p>
<h3>Charging Session Data</h3>
<p>We collect data related to your charging sessions, including session start and end times, energy delivered (kWh), charging station location, vehicle connector type, and transaction amounts.</p>
<h3>Payment Information</h3>
<p>Payment card details are processed by our payment processor and are not stored on our servers. We retain transaction records including amounts, dates, and the last four digits of your payment method.</p>

<h2>How We Use Your Information</h2>
<p>We use your information to process payments and provide charging services, send transaction receipts and account notifications, improve our charging network and services, comply with legal obligations, and resolve disputes and troubleshoot issues.</p>

<h2>Data Sharing</h2>
<p>We do not sell your personal information. We may share data with payment processors to complete transactions, roaming network partners to enable charging at partner stations, and service providers who assist in operating our platform, subject to confidentiality obligations.</p>

<h2>Data Retention</h2>
<p>We retain account information for the duration of your account and for up to seven years after closure to comply with financial regulations. Charging session data is retained for three years.</p>

<h2>Security</h2>
<p>We implement industry-standard security measures including encryption in transit and at rest, access controls, and regular security assessments to protect your personal information.</p>

<h2>Your Rights</h2>
<p>Depending on your jurisdiction, you may have the right to access, correct, or delete your personal information. To exercise these rights, contact us at [Contact Email].</p>

<h2>Contact Us</h2>
<p>If you have questions about this Privacy Policy, please contact us at [Contact Email].</p>`,

    'terms-of-service': `<h1>Terms of Service</h1>
<p>Last updated: January 1, 2025</p>

<h2>Acceptance of Terms</h2>
<p>By accessing or using the EV charging services provided by [Company Name] ("we," "our," or "us"), you agree to be bound by these Terms of Service. If you do not agree, do not use our services.</p>

<h2>Service Description</h2>
<p>We operate a network of electric vehicle charging stations. Our services include access to charging hardware, session management, billing, and account management through our application and website.</p>

<h2>Account Registration</h2>
<p>You must create an account to access most of our services. You are responsible for maintaining the confidentiality of your account credentials and for all activity that occurs under your account. You must provide accurate and complete information during registration.</p>

<h2>Charging Services and Payment</h2>
<p>Charging sessions are billed based on energy delivered (kWh), time, or a flat session fee as displayed at the station or in the application. You authorize us to charge your payment method on file for all sessions initiated under your account. All fees are non-refundable except as required by law or as determined at our sole discretion.</p>

<h2>Prohibited Uses</h2>
<p>You agree not to use our services for any unlawful purpose, interfere with or damage charging equipment, share your account credentials with unauthorized users, or attempt to circumvent billing or authentication systems.</p>

<h2>Limitation of Liability</h2>
<p>To the maximum extent permitted by law, [Company Name] shall not be liable for any indirect, incidental, special, or consequential damages arising from your use of our services, including vehicle damage, loss of data, or service interruptions.</p>

<h2>Governing Law</h2>
<p>These Terms are governed by the laws of the jurisdiction in which [Company Name] is incorporated, without regard to conflict of law principles.</p>

<h2>Changes to Terms</h2>
<p>We may update these Terms from time to time. We will notify you of material changes via email or in-app notification. Continued use of our services after changes take effect constitutes acceptance of the updated Terms.</p>

<h2>Contact Us</h2>
<p>For questions about these Terms of Service, please contact us at [Contact Email].</p>`,
  },

  es: {
    'privacy-policy': `<h1>Politica de Privacidad</h1>
<p>Ultima actualizacion: 1 de enero de 2025</p>

<h2>Introduccion</h2>
<p>[Nombre de la empresa] ("nosotros," "nuestro," o "nos") opera una red de carga para vehiculos electricos (VE). Esta Politica de Privacidad explica como recopilamos, usamos y protegemos su informacion personal cuando utiliza nuestros servicios de carga, aplicacion movil y sitio web.</p>

<h2>Informacion que Recopilamos</h2>
<h3>Datos de Cuenta</h3>
<p>Cuando crea una cuenta, recopilamos su nombre, direccion de correo electronico, numero de telefono e informacion de facturacion necesaria para proporcionar servicios de carga.</p>
<h3>Datos de Sesion de Carga</h3>
<p>Recopilamos datos relacionados con sus sesiones de carga, incluyendo horas de inicio y fin de sesion, energia entregada (kWh), ubicacion de la estacion de carga, tipo de conector del vehiculo y montos de transaccion.</p>
<h3>Informacion de Pago</h3>
<p>Los detalles de la tarjeta de pago son procesados por nuestro procesador de pagos y no se almacenan en nuestros servidores. Conservamos registros de transacciones que incluyen montos, fechas y los ultimos cuatro digitos de su metodo de pago.</p>

<h2>Como Usamos su Informacion</h2>
<p>Utilizamos su informacion para procesar pagos y proporcionar servicios de carga, enviar recibos de transacciones y notificaciones de cuenta, mejorar nuestra red de carga y servicios, cumplir con obligaciones legales y resolver disputas y solucionar problemas.</p>

<h2>Comparticion de Datos</h2>
<p>No vendemos su informacion personal. Podemos compartir datos con procesadores de pago para completar transacciones, socios de red de roaming para habilitar la carga en estaciones asociadas, y proveedores de servicios que ayudan a operar nuestra plataforma, sujeto a obligaciones de confidencialidad.</p>

<h2>Retencion de Datos</h2>
<p>Conservamos la informacion de la cuenta durante la duracion de su cuenta y hasta siete anos despues del cierre para cumplir con las regulaciones financieras. Los datos de sesion de carga se conservan durante tres anos.</p>

<h2>Seguridad</h2>
<p>Implementamos medidas de seguridad estandar de la industria que incluyen cifrado en transito y en reposo, controles de acceso y evaluaciones de seguridad regulares para proteger su informacion personal.</p>

<h2>Sus Derechos</h2>
<p>Dependiendo de su jurisdiccion, puede tener derecho a acceder, corregir o eliminar su informacion personal. Para ejercer estos derechos, contactenos en [Correo de Contacto].</p>

<h2>Contactenos</h2>
<p>Si tiene preguntas sobre esta Politica de Privacidad, comuniquese con nosotros en [Correo de Contacto].</p>`,

    'terms-of-service': `<h1>Terminos de Servicio</h1>
<p>Ultima actualizacion: 1 de enero de 2025</p>

<h2>Aceptacion de los Terminos</h2>
<p>Al acceder o utilizar los servicios de carga de VE proporcionados por [Nombre de la empresa] ("nosotros," "nuestro," o "nos"), usted acepta estar sujeto a estos Terminos de Servicio. Si no esta de acuerdo, no utilice nuestros servicios.</p>

<h2>Descripcion del Servicio</h2>
<p>Operamos una red de estaciones de carga para vehiculos electricos. Nuestros servicios incluyen acceso al hardware de carga, gestion de sesiones, facturacion y gestion de cuentas a traves de nuestra aplicacion y sitio web.</p>

<h2>Registro de Cuenta</h2>
<p>Debe crear una cuenta para acceder a la mayoria de nuestros servicios. Usted es responsable de mantener la confidencialidad de las credenciales de su cuenta y de toda la actividad que ocurra bajo su cuenta. Debe proporcionar informacion precisa y completa durante el registro.</p>

<h2>Servicios de Carga y Pago</h2>
<p>Las sesiones de carga se facturan en funcion de la energia entregada (kWh), el tiempo o una tarifa de sesion fija que se muestra en la estacion o en la aplicacion. Usted nos autoriza a cobrar su metodo de pago registrado por todas las sesiones iniciadas bajo su cuenta. Todas las tarifas son no reembolsables salvo que la ley lo requiera o segun nuestra discrecion exclusiva.</p>

<h2>Usos Prohibidos</h2>
<p>Usted acepta no utilizar nuestros servicios para ningun proposito ilegal, interferir o danar los equipos de carga, compartir las credenciales de su cuenta con usuarios no autorizados o intentar eludir los sistemas de facturacion o autenticacion.</p>

<h2>Limitacion de Responsabilidad</h2>
<p>En la maxima medida permitida por la ley, [Nombre de la empresa] no sera responsable de ningun dano indirecto, incidental, especial o consecuente derivado del uso de nuestros servicios, incluyendo danos al vehiculo, perdida de datos o interrupciones del servicio.</p>

<h2>Ley Aplicable</h2>
<p>Estos Terminos se rigen por las leyes de la jurisdiccion en la que [Nombre de la empresa] esta constituida, sin tener en cuenta los principios de conflicto de leyes.</p>

<h2>Cambios en los Terminos</h2>
<p>Podemos actualizar estos Terminos de vez en cuando. Le notificaremos los cambios materiales por correo electronico o notificacion en la aplicacion. El uso continuado de nuestros servicios despues de que los cambios entren en vigor constituye la aceptacion de los Terminos actualizados.</p>

<h2>Contactenos</h2>
<p>Para preguntas sobre estos Terminos de Servicio, comuniquese con nosotros en [Correo de Contacto].</p>`,
  },

  zh: {
    'privacy-policy': `<h1>隐私政策</h1>
<p>最后更新：2025年1月1日</p>

<h2>简介</h2>
<p>[公司名称]（以下简称"我们"）运营一个电动汽车（EV）充电网络。本隐私政策说明了当您使用我们的充电服务、移动应用程序和网站时，我们如何收集、使用和保护您的个人信息。</p>

<h2>我们收集的信息</h2>
<h3>账户数据</h3>
<p>当您创建账户时，我们会收集您的姓名、电子邮件地址、电话号码以及提供充电服务所需的账单信息。</p>
<h3>充电会话数据</h3>
<p>我们收集与您的充电会话相关的数据，包括会话开始和结束时间、充电量（kWh）、充电站位置、车辆连接器类型和交易金额。</p>
<h3>支付信息</h3>
<p>支付卡详情由我们的支付处理商处理，不存储在我们的服务器上。我们保留包括金额、日期和您支付方式后四位数字的交易记录。</p>

<h2>我们如何使用您的信息</h2>
<p>我们使用您的信息来处理付款和提供充电服务、发送交易收据和账户通知、改善我们的充电网络和服务、履行法律义务以及解决争议和排查问题。</p>

<h2>数据共享</h2>
<p>我们不出售您的个人信息。我们可能会与支付处理商共享数据以完成交易，与漫游网络合作伙伴共享数据以在合作伙伴站点启用充电，以及与协助运营我们平台的服务提供商共享数据，但须遵守保密义务。</p>

<h2>数据保留</h2>
<p>我们在账户存续期间以及关闭后最多七年内保留账户信息，以符合金融法规要求。充电会话数据保留三年。</p>

<h2>安全性</h2>
<p>我们实施行业标准安全措施，包括传输中和静态加密、访问控制以及定期安全评估，以保护您的个人信息。</p>

<h2>您的权利</h2>
<p>根据您所在的司法管辖区，您可能有权访问、更正或删除您的个人信息。要行使这些权利，请通过[联系邮箱]联系我们。</p>

<h2>联系我们</h2>
<p>如果您对本隐私政策有任何疑问，请通过[联系邮箱]联系我们。</p>`,

    'terms-of-service': `<h1>服务条款</h1>
<p>最后更新：2025年1月1日</p>

<h2>条款接受</h2>
<p>通过访问或使用[公司名称]（以下简称"我们"）提供的电动汽车充电服务，您同意受这些服务条款的约束。如果您不同意，请勿使用我们的服务。</p>

<h2>服务描述</h2>
<p>我们运营一个电动汽车充电站网络。我们的服务包括通过我们的应用程序和网站访问充电硬件、会话管理、账单和账户管理。</p>

<h2>账户注册</h2>
<p>您必须创建账户才能访问我们的大多数服务。您负责维护账户凭据的保密性，以及在您账户下发生的所有活动。注册时必须提供准确和完整的信息。</p>

<h2>充电服务和付款</h2>
<p>充电会话根据充电量（kWh）、时间或在充电站或应用程序中显示的固定会话费用收费。您授权我们向您存档的支付方式收取在您账户下发起的所有会话费用。除法律要求或由我们自行决定外，所有费用均不可退款。</p>

<h2>禁止使用</h2>
<p>您同意不将我们的服务用于任何非法目的、干扰或损坏充电设备、与未经授权的用户共享账户凭据，或试图规避计费或身份验证系统。</p>

<h2>责任限制</h2>
<p>在法律允许的最大范围内，[公司名称]对因使用我们服务而产生的任何间接、附带、特殊或后果性损害不承担责任，包括车辆损坏、数据丢失或服务中断。</p>

<h2>适用法律</h2>
<p>这些条款受[公司名称]注册地司法管辖区的法律管辖，不考虑法律冲突原则。</p>

<h2>条款变更</h2>
<p>我们可能会不时更新这些条款。我们将通过电子邮件或应用内通知告知您重大变更。变更生效后继续使用我们的服务即表示接受更新后的条款。</p>

<h2>联系我们</h2>
<p>有关这些服务条款的问题，请通过[联系邮箱]联系我们。</p>`,
  },
};
