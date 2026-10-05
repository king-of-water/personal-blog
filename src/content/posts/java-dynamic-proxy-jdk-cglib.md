---
title: 动态代理：JDK 代理与 CGLIB
description: 拆解动态代理的本质——运行时生成代理类、拦截方法调用，讲清 JDK 动态代理的 Proxy + InvocationHandler 与 CGLIB 的 Enhancer + MethodInterceptor 两种实现，它们对接口与类的不同要求、反射与字节码的取舍，以及 Spring AOP 怎么选。
category: 后端
subcategory: Java
articleClass: focused
seriesOrder: 30
featured: true
publishedAt: 2026-10-05
updatedAt: 2026-10-05
tags: [Java, 动态代理, JDK 代理, CGLIB, InvocationHandler, MethodInterceptor, Spring AOP, 字节码]
---

想在「每个方法调用前后打日志」而不改原类，怎么办？直接在每个方法里写日志，是复制粘贴的灾难；继承重写所有方法，又受 `final` 和类的限制。动态代理就是为解决这类"横切关注点"而生的——它在运行时生成一个代理对象，替你包住真实对象，所有方法调用都先经过代理，代理再决定要不要调用、调用前后做什么。

动态代理是 Spring AOP、MyBatis Mapper、RPC 远程调用桩这些技术共同的地基。理解它，就理解了"为什么 Spring 能给你的 Service 自动加事务、加日志"。

本文回答一个问题：动态代理到底怎么"在运行时生成一个能拦截方法调用的对象"，JDK 动态代理和 CGLIB 两种实现各有什么边界，实际工程里怎么选。主要依据是 JDK 源码和 Spring 文档，版本差异在关键处标注。

## 一、动态代理的本质：包一层，拦一道

静态代理是手写一个代理类，它和真实类实现同一个接口，内部持有一个真实对象，每个方法里转发调用。问题很明显：真实类每加一个方法，代理类就得跟着加一个转发方法，方法一多就爆炸。

动态代理把"手写代理类"换成"运行时生成代理类"。你要做的只是提供一个拦截逻辑（一个回调），JVM 或字节码库在运行时帮你生成那个代理类、创建代理对象。之后你对代理对象的每次方法调用，都会先进入你的拦截逻辑，由你决定是否调用真实对象、调用前后做什么。

![动态代理在真实对象外包一层拦截](/images/posts/java-proxy-mechanism.svg)

这张图是动态代理的通用模型，不区分实现：调用方拿到的是代理对象（长得和真实对象一样），调用它的方法，请求先到拦截器，拦截器可以记录日志、做校验、开事务，然后转发给真实对象。真实对象不知道自己被代理了——这正是"不改原类"的关键。

## 二、JDK 动态代理：只能代理接口

JDK 内置的动态代理靠 `java.lang.reflect.Proxy` 和 `InvocationHandler` 两个类实现。用法是：给一个接口和一个 `InvocationHandler`，`Proxy.newProxyInstance` 返回一个实现了该接口的代理对象。

```java
interface UserService {
    void save(User u);
}

UserService target = new UserServiceImpl();
UserService proxy = (UserService) Proxy.newProxyInstance(
    target.getClass().getClassLoader(),
    new Class<?>[]{UserService.class},
    (proxyObj, method, args) -> {
        System.out.println("before: " + method.getName());
        Object result = method.invoke(target, args);   // 反射调用真实对象
        System.out.println("after: " + method.getName());
        return result;
    });
proxy.save(user);   // 实际先经过 InvocationHandler
```

这里有个硬限制：JDK 动态代理**只能代理接口**。原因是生成的代理类已经 `extends Proxy`，而 Java 是单继承，没法再继承你的具体类，只能去实现你指定的接口。所以目标对象必须实现至少一个接口，否则 JDK 动态代理用不了。

`InvocationHandler.invoke` 里调用真实方法用的是 `method.invoke(target, args)`，这是反射调用。反射在 JDK 7 之前很慢，JDK 7 之后做了优化（`MethodHandle`、调用点缓存），性能差距被拉近，但本质仍是反射转发。

## 三、CGLIB：用字节码生成子类

CGLIB 走的是另一条路：它不要求接口，而是通过字节码操作（底层是 ASM）**生成目标类的子类**，子类重写所有非 `final` 方法，在重写的方法里插入拦截逻辑。

```java
Enhancer enhancer = new Enhancer();
enhancer.setSuperclass(UserServiceImpl.class);      // 生成 UserServiceImpl 的子类
enhancer.setCallback((MethodInterceptor) (obj, method, args, methodProxy) -> {
    System.out.println("before: " + method.getName());
    Object result = methodProxy.invokeSuper(obj, args);  // 调用父类（真实）方法
    System.out.println("after: " + method.getName());
    return result;
});
UserServiceImpl proxy = (UserServiceImpl) enhancer.create();
proxy.save(user);
```

CGLIB 的代理对象是真实类的**子类**，所以能代理"没有接口的类"，这是它相对 JDK 动态代理最大的优势。但它也有对应的限制：`final` 方法不能被重写、`final` 类不能被子类化，这两类 CGLIB 都代理不了。

`MethodInterceptor` 里有个经典坑：`methodProxy.invokeSuper(obj, args)` 调用的是父类（真实类）的方法，`methodProxy.invoke(obj, args)` 调用的却是代理对象自己的方法。用错后者，方法会再次进入拦截器、无限递归直到栈溢出。所以拦截逻辑里转发真实调用，必须用 `invokeSuper`——这一个字母的差别，是 CGLIB 使用者最常踩的坑。

性能上，CGLIB 生成的子类方法里是直接调用，不像 JDK 代理那样走反射，所以历史上 CGLIB 比 JDK 动态代理快。但 JDK 7 之后 JDK 动态代理优化明显，两者差距已经不大，选择时通常不再以性能为主要依据。

## 四、两者的边界，一张图加一张表

两者最本质的区别在继承关系上，看这张图比看文字清楚：

![JDK 代理靠实现接口，CGLIB 靠继承子类](/images/posts/jdk-vs-cglib.svg)

JDK 动态代理的代理类和真实类是"兄弟"——都实现同一个接口，代理内部持有真实对象、转发调用；CGLIB 的代理类是真实类的"儿子"——继承真实类、重写方法。这个继承关系的差异，直接决定了它们的限制：单继承逼得 JDK 代理只能面向接口，继承又让 CGLIB 拿 `final` 没办法。

| 维度 | JDK 动态代理 | CGLIB |
| --- | --- | --- |
| 代理对象是什么 | 实现接口的新类 | 目标类的子类 |
| 对目标的要求 | 必须实现至少一个接口 | 类不能是 final，方法不能是 final |
| 方法调用方式 | 反射（`method.invoke`） | 字节码直接调用（`invokeSuper`） |
| 依赖 | JDK 内置 | 需引入 CGLIB + ASM |
| 典型使用 | 接口明确的场景 | 无接口的类 |

选择逻辑其实很简单：**目标有接口用 JDK 代理，目标没接口用 CGLIB**。很多场景里目标类都实现了接口（面向接口编程），所以 JDK 代理够用；而当你需要代理一个没有接口的普通类时，CGLIB 就是唯一选择。

## 五、Spring AOP 怎么选

Spring AOP 内部就用这两种动态代理，选择规则和上面一致：目标实现了接口，默认用 JDK 动态代理；目标没实现接口，退到 CGLIB。

一个容易搞混的点是 Spring Boot 的默认值。Spring Boot 2.0 起，`spring.aop.proxy-target-class` 默认是 `true`，意味着**默认优先用 CGLIB**，即使目标实现了接口。这个默认值的理由是 CGLIB 行为更统一（不用关心目标到底有没有接口），也避免某些场景下"接口代理"和"类代理"混用导致的坑。但如果你明确只用接口编程，也可以设回 `false` 用 JDK 动态代理。

所以"Spring AOP 用 JDK 还是 CGLIB"的答案分两层：Spring 框架本身的规则是"有接口用 JDK、没接口用 CGLIB"；Spring Boot 则默认直接用 CGLIB。这解释了为什么很多人以为"Spring 就是 CGLIB"，其实只是 Boot 改了默认值。

动态代理的价值不在"包一层"这个动作，而在它把"横切逻辑"从业务代码里抽了出来。事务、日志、权限、缓存、远程调用，这些和业务本身无关、却要在每个方法前后做的事，正是因为有了动态代理，才能"不改原类"地统一织入。理解了它，Spring 那一堆 `@Transactional`、`@Cacheable` 注解，就不再是魔法，而是"代理对象替你拦了一道"。

## 参考资料

- [Oracle：Proxy（JavaDoc）](https://docs.oracle.com/javase/8/docs/api/java/lang/reflect/Proxy.html)
- [Oracle：InvocationHandler（JavaDoc）](https://docs.oracle.com/javase/8/docs/api/java/lang/reflect/InvocationHandler.html)
- [Spring Framework：AOP Proxies](https://docs.spring.io/spring-framework/reference/core/aop/proxying.html)
- [cglib：Github](https://github.com/cglib/cglib)
